import { wait } from 'mentie'
import { log } from '../utils/log.js'
import { capture_pane } from '../tmux/capture.js'
import { send_keys } from '../tmux/send.js'
import { has_session, kill_session, set_agent_status } from '../tmux/session.js'
import { IdleTracker, strip_ansi, evaluate_rule, idle_timeout_for } from './matcher.js'
import { execute_action } from './actions.js'
import { extract_session_id } from '../sessions/extract.js'
import { write_loop_deadline } from '../statusline/render.js'
import { agent_status as detect_agent_status } from './activity.js'
import { WATCHDOG_NUDGE } from './watchdog.js'

// Poll interval for pane capture
const POLL_INTERVAL_MS = 1_000

// A failed has-session is not proof the session ended: a busy tmux server or a
// failed spawn looks the same. Ending on one miss orphans a live agent with no
// monitor (no YOLO approvals, no nudges), so confirm across this many checks.
const SESSION_GONE_CHECKS = 5
export const AGENT_EXIT_SENTINEL = `__BABYSIT_AGENT_EXIT__`
const log_shutdown_timing = message => process.env.BABYSIT_DEBUG === `1`
    ? log.info( message )
    : log.debug( message )

// Debounce between consecutive fires of the same rule (sir-claudius lesson: redraw flicker)
export const DEBOUNCE_MS = 3_000

// Give an answered dialog time to close before judging a fresh one.
export const APPROVAL_COOLDOWN_MS = 2_000

// A lost login on screen asks for a real check at most this often while the
// screen keeps showing it
export const LOGOUT_RECHECK_MS = 15 * 60_000
const LOGOUT_SCREEN_LINES = 25

// An alert needs the error close to the composer: Claude 2.1.304 renders its
// 401 line 7 non-blank lines up (status, separators, composer, footer)
const SESSION_ALERT_LINES = 10

// Prompt lines: Claude `❯`, Codex `›`; submitted ones carry text. Not `>`:
// a markdown quote inside a multi-line draft would pass for a prompt.
const PROMPT_LINE = /^\s*[❯›](?:\s|$)/
const SUBMITTED_PROMPT = /^\s*[❯›]\s+\S/

// A limit message on screen asks for an account switch at most this often
export const LIMIT_RECHECK_MS = 10 * 60_000
const LIMIT_SCREEN_LINES = 15

/**
 * The last `count` non-blank lines of a pane. Claude pins its composer to the
 * bottom, so a short transcript leaves a tall blank gap above it: counting raw
 * rows would cut off the very lines that matter.
 * @param {string} screen - ANSI-free pane capture
 * @param {number} count - Lines to keep
 * @returns {string} Joined tail
 */
const screen_tail = ( screen, count ) => screen
    .split( `\n` )
    .filter( line => line.trim() )
    .slice( -count )
    .join( `\n` )

/**
 * Whether the bottom of the pane shows the agent's subscription-limit message.
 * A hint like shows_logout: the switcher re-reads the account's quota first.
 * @param {string} screen - ANSI-free pane capture
 * @param {Object} agent - Adapter with limit_pattern
 * @returns {boolean} True when the latest lines match
 */
export const shows_limit = ( screen = ``, agent = null ) => {
    const pattern = agent?.limit_pattern
    return Boolean( pattern?.test( screen_tail( screen, LIMIT_SCREEN_LINES ) ) )
}

/**
 * Whether the bottom of the pane shows the agent's own logged-out message.
 * A hint, not a verdict: transcript text can quote the same words.
 * @param {string} screen - ANSI-free pane capture
 * @param {Object} agent - Adapter with auth_check.failure_pattern
 * @returns {boolean} True when the latest lines match
 */
export const shows_logout = ( screen = ``, agent = null ) => {
    const pattern = agent?.auth_check?.failure_pattern
    return Boolean( pattern?.test( screen_tail( screen, LOGOUT_SCREEN_LINES ) ) )
}

/**
 * Whether the lost login on screen is the agent's own error line, specific
 * enough to alert on. Without a session_alert_pattern only the host check runs.
 * @param {string} screen - ANSI-free pane capture
 * @param {Object} agent - Adapter with auth_check.session_alert_pattern
 * @returns {boolean} True when the latest lines carry the agent's own error
 */
export const shows_session_logout = ( screen = ``, agent = null ) => {

    const pattern = agent?.auth_check?.session_alert_pattern
    if( !pattern ) return false

    // The error must be the agent's latest word: near the composer, with no
    // prompt submitted after it (a retry that worked leaves the old 401 on screen)
    const lines = screen_tail( screen, SESSION_ALERT_LINES ).split( `\n` )
    const at = lines.findLastIndex( line => pattern.test( line ) )
    if( at === -1 ) return false

    // The last prompt line is the live composer: its placeholder (`› Ask Codex
    // to do anything`) or an unsent draft is no evidence. Any earlier one is.
    const prompts = lines.slice( at + 1 ).filter( line => PROMPT_LINE.test( line ) )
    return !prompts.slice( 0, -1 ).some( line => SUBMITTED_PROMPT.test( line ) )

}

/**
 * Read the supervised entrypoint's process exit marker from pane output.
 * @param {string} output - ANSI-normalised tmux pane output
 * @param {string|null} sentinel - Random token assigned to this session
 * @returns {number|null} Agent exit status, or null while the agent is running
 */
export const agent_exit_status = ( output = ``, sentinel = null ) => {

    if( !sentinel ) return null

    const escaped_sentinel = String( sentinel ).replace( /[.*+?^${}()|[\]\\]/g, `\\$&` )
    const pattern = new RegExp(
        `(?:^|\\n)${ AGENT_EXIT_SENTINEL }:${ escaped_sentinel }:(\\d{1,3})(?:\\n|$)`
    )
    const match = String( output ).replace( /\r/g, `` ).match( pattern )
    const status = match ? Number( match[1] ) : null

    return status !== null && status <= 255 ? status : null

}

/**
 * Publish an activity transition, retaining the previous state on failure so
 * the monitor retries next tick.
 * @param {Object} options
 * @param {string} options.session_name - Babysit tmux session name
 * @param {'idle'|'running'|'waiting'} options.agent_status - Newly observed activity
 * @param {'idle'|'running'|'waiting'|null} options.last_agent_status - Last published activity
 * @param {Function} [options.publish=set_agent_status] - Tmux publisher seam
 * @returns {Promise<'idle'|'running'|'waiting'|null>} Last successfully published activity
 */
export const publish_agent_status = async ( {
    session_name,
    agent_status,
    last_agent_status,
    publish = set_agent_status,
} ) => {

    if( agent_status === last_agent_status ) return last_agent_status

    const published = await publish( session_name, agent_status )
    return published ? agent_status : last_agent_status

}


/**
 * Decide whether a rule should fire on this tick: the rule must match and
 * must not have fired within the debounce window. Idle rules carry their own
 * timing inside evaluate_rule; literal and regex rules fire on sight.
 *
 * @param {Object} rule - Parsed rule with on/timeout_s/last_fired_at
 * @param {Object} context - { output, idle_seconds, config }
 * @param {number} now - `Date.now()` for this tick
 * @returns {boolean} True if the action should fire this tick
 */
export const should_fire_rule = ( rule, context, now ) => {

    // Per-rule debounce — suppresses TUI redraw flicker from re-firing the same rule
    if( now - rule.last_fired_at < DEBOUNCE_MS ) return false

    return evaluate_rule( rule, context )

}

/**
 * Start the babysit monitoring loop
 * Watches a tmux session and executes babysit.yaml rules based on output
 * @param {Object} options
 * @param {string} options.session_name - Tmux session name
 * @param {Object} options.config - Parsed babysit config
 * @param {Array} options.rules - Parsed babysit rules
 * @param {Object} options.agent - Agent adapter
 * @param {Object|null} [options.web_bridge] - Optional filesystem bridge controller
 * @param {Function|null} [options.open_web_bridge_fn] - Retry bridge initialization until enabled
 * @param {boolean} [options.approve_dialogs=false] - YOLO: accept the agent's blocking prompts whose default is yes
 * @param {string} [options.tmux_target] - Launch-bound agent pane when known
 * @param {Function} [options.on_session_id] - Callback when agent session ID is captured
 * @param {Function} [options.on_logout_screen] - Callback with the agent name and { alertable } when the pane shows a lost login
 * @param {Function} [options.on_limit_screen] - Callback when the pane shows a subscription limit
 * @param {Function} [options.on_status] - Callback with each tick's agent status
 * @param {Function} [options.on_user_input] - Callback when the web companion delivered user input
 * @param {Object|null} [options.watchdog] - Stall watchdog from create_watchdog
 * @param {Function} [options.is_frozen] - Async: the current `babysit freeze` mark, falsy when not frozen
 * @param {Function} [options.on_frozen] - Called with each mark once the monitor stood down for it (freeze waits for that), null on thaw
 * @param {Function} [options.on_exit] - Callback when session ends
 * @returns {Promise<void>}
 */
export const start_monitor = async ( {
    session_name,
    config,
    rules,
    agent,
    web_bridge = null,
    open_web_bridge_fn = null,
    control_bridge = null,
    approve_dialogs = false,
    tmux_target = session_name,
    on_session_id,
    on_logout_screen = null,
    on_limit_screen = null,
    on_tick,
    on_status = null,
    on_user_input = null,
    watchdog = null,
    input_allowed = () => true,
    is_frozen = async () => false,
    on_frozen = null,
    on_exit,
    agent_exit_sentinel = null,
    has_session_fn = has_session,
    capture_pane_fn = capture_pane,
    kill_session_fn = kill_session,
    publish_agent_status_fn = publish_agent_status,
    execute_action_fn = execute_action,
    send_keys_fn = send_keys,
    write_loop_deadline_fn = write_loop_deadline,
    wait_fn = wait,
} ) => {

    const idle_tracker = new IdleTracker()
    let session_id_captured = false
    let last_written_deadline = null
    let last_agent_status = null
    let action_task = null
    let action_busy = false
    let reset_after_action = false
    let agent_target = web_bridge?.tmux_target || tmux_target
    let control_revision = control_bridge?.revision || 0
    let approval_ready_at = 0
    let logout_check_ready_at = 0
    let limit_check_ready_at = 0
    let frozen = false
    let acked_mark = null

    const begin_action = ( rule, now ) => {

        log.info( `Rule matched: on=${ rule.on.type }${ rule.on.value ? ` (${ rule.on.value })` : `` }` )
        rule.last_fired_at = now
        action_busy = true

        // Long segmented actions wait for the agent between messages. Keep the
        // monitor heartbeat and pane publishing alive while that happens, but
        // give the action exclusive ownership of tmux input.
        action_task = Promise.resolve()
            .then( () => execute_action_fn( agent_target, rule.do, config ) )
            .catch( error => log.error( `Action failed: ${ error.message }` ) )
            .finally( () => {
                action_busy = false
                reset_after_action = true
            } )

    }

    const finish_action = async () => {
        if( action_task ) await action_task
        action_task = null
    }

    // Find the idle rule once — used to publish the countdown for the statusline
    const idle_rule = rules.find( r => r.on.type === `idle` )

    // The watchdog's nudge runs as a regular action so it owns tmux input the same way
    const watchdog_rule = { on: { type: `watchdog` }, do: WATCHDOG_NUDGE, last_fired_at: 0 }

    // Gone only when every check over ~SESSION_GONE_CHECKS seconds misses
    const session_gone = async () => {
        for( let check = 1; check <= SESSION_GONE_CHECKS; check++ ) {
            if( await has_session_fn( session_name ) ) return false
            if( check < SESSION_GONE_CHECKS ) await wait_fn( POLL_INTERVAL_MS )
        }
        return true
    }

    log.info( `Monitoring session: ${ session_name }` )
    log.debug( `${ rules.length } rules loaded, polling every ${ POLL_INTERVAL_MS }ms` )

    try {

        while( true ) {

            // Frozen (`babysit freeze`): anything typed into the paused pane would
            // replay on thaw, and docker exec fails against a paused container.
            // A babysit action still typing finishes first and nothing new starts;
            // then the monitor stands down, acknowledges (freeze pauses only
            // after that) and only watches for the session ending.
            const frozen_mark = await is_frozen()
            if( frozen_mark ) {
                if( !frozen && action_busy ) {
                    await wait_fn( POLL_INTERVAL_MS )
                    continue
                }
                if( !frozen ) {
                    log.info( `Session frozen; monitor standing down until babysit unfreeze` )
                    frozen = true
                }
                // Every freeze waits for its own mark: a quick unfreeze + freeze
                // between ticks must not go unanswered
                if( frozen_mark !== acked_mark ) {
                    acked_mark = frozen_mark
                    await on_frozen?.( frozen_mark )
                }
                if( await session_gone() ) {
                    log.info( `Session ended while frozen: ${ session_name }` )
                    await finish_action()
                    if( on_exit ) await on_exit( { exit_status: null } )
                    break
                }
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            if( frozen ) {
                log.info( `Session unfrozen; monitor resumed` )
                frozen = false
                acked_mark = null
                await on_frozen?.( null )
                idle_tracker.reset()
                watchdog?.restart()
                approval_ready_at = Date.now() + APPROVAL_COOLDOWN_MS
            }

            on_tick?.()
            if( control_bridge && control_bridge.revision !== control_revision ) {
                idle_tracker.reset()
                control_revision = control_bridge.revision
            }

            if( reset_after_action ) {
                idle_tracker.reset()
                reset_after_action = false
                action_task = null
            }

            // Check if session is still alive
            if( await session_gone() ) {
                log.info( `Session ended: ${ session_name }` )
                write_loop_deadline_fn( `idle` )
                await finish_action()
                if( on_exit ) await on_exit( { exit_status: null } )
                break
            }

            // Web access may be initialized after this session starts. Retry on
            // each tick so running sessions appear without restarting the agent.
            if( !web_bridge && open_web_bridge_fn ) {
                web_bridge = await open_web_bridge_fn()
                agent_target = web_bridge?.tmux_target || tmux_target
            }

            // Capture pane output
            let raw_output
            try {
                raw_output = await capture_pane_fn( agent_target )
            } catch {
                log.debug( `Failed to capture pane, session may be closing` )
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // Clean ANSI sequences
            const clean_output = strip_ansi( raw_output )

            // Track idle state
            const idle_seconds = idle_tracker.update( clean_output )
            const agent_status = detect_agent_status( clean_output, agent?.name, idle_seconds )

            // Background terminals are unfinished work, even when their pane
            // is static. Restart the idle timer once their footer disappears.
            if( agent_status === `waiting` ) idle_tracker.reset()
            if( on_status ) await on_status( agent_status )
            watchdog?.observe( agent_status )

            // Store activity with the tmux session itself. Only transitions issue
            // a command, keeping the one-second monitor poll cheap. Failed writes
            // stay pending so a transient tmux error is retried on the next tick.
            last_agent_status = await publish_agent_status_fn( {
                session_name,
                agent_status,
                last_agent_status,
            } )

            // Publish the idle countdown deadline for the statusline (only when it changes)
            if( idle_rule ) {
                const deadline = agent_status === `waiting` ? `idle` : idle_tracker.get_deadline( idle_timeout_for( idle_rule, config ) )
                if( deadline !== null && deadline !== last_written_deadline ) {
                    write_loop_deadline_fn( deadline )
                    last_written_deadline = deadline
                }
            }

            // Try to capture session ID from agent output (one-time)
            if( !session_id_captured && agent?.session_id_pattern ) {
                const captured_id = extract_session_id( clean_output, agent.session_id_pattern )
                if( captured_id ) {
                    session_id_captured = true
                    log.info( `Captured agent session ID: ${ captured_id }` )
                    if( on_session_id ) on_session_id( captured_id )
                }
            }

            // The probe it starts decides whether to alert. Re-asks while the
            // screen still shows it, so a check skipped for a busy lease retries.
            if( on_logout_screen && Date.now() >= logout_check_ready_at && shows_logout( clean_output, agent ) ) {
                log.info( `Pane shows a lost ${ agent.name } login; requesting an authentication check` )
                logout_check_ready_at = Date.now() + LOGOUT_RECHECK_MS
                on_logout_screen( agent.name, { alertable: shows_session_logout( clean_output, agent ) } )
            }

            // Not awaited: the handler probes accounts and may restart the session
            // (it logs the sighting itself, only when an account switch is possible)
            if( on_limit_screen && Date.now() >= limit_check_ready_at && shows_limit( clean_output, agent ) ) {
                limit_check_ready_at = Date.now() + LIMIT_RECHECK_MS
                on_limit_screen( agent.name )
            }

            // The entrypoint knows when the coding agent exits before Docker's
            // daemon finishes its bounded stream/task cleanup. Capture the native
            // session id first, then end tmux so the foreground CLI can return while
            // the detached monitor finalises credentials safely.
            const exit_status = agent_exit_status( clean_output, agent_exit_sentinel )
            if( exit_status !== null ) {
                const exit_started_at = Date.now()

                log_shutdown_timing( `Shutdown: agent exited with status ${ exit_status }; releasing tmux foreground` )
                write_loop_deadline_fn( `idle` )
                await kill_session_fn( session_name )
                log_shutdown_timing( `Shutdown: tmux released in ${ Date.now() - exit_started_at }ms` )
                await finish_action()
                if( on_exit ) await on_exit( { exit_status } )
                break
            }

            // YOLO: accept prompts that still stop the agent, the way a person
            // would. Babysit's own input owners finish first.
            const dialog = approve_dialogs && agent?.yolo_dialog?.( clean_output )
            if( dialog && !action_busy && !control_bridge?.busy && input_allowed() && Date.now() >= approval_ready_at ) {
                log.info( `YOLO answered "${ dialog.answer }" to "${ dialog.question }"${ dialog.title ? ` (${ dialog.title.slice( 0, 120 ) })` : `` }` )
                await send_keys_fn( agent_target, `Enter` )
                approval_ready_at = Date.now() + APPROVAL_COOLDOWN_MS
                idle_tracker.reset()
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // Publish first, then claim a bounded request batch. An in-flight
            // Babysit action keeps ownership of the pane and rejects web input
            // explicitly instead of interleaving keystrokes.
            let bridge_sent = false
            control_bridge?.tick( { blocked: action_busy || !input_allowed(), busy: agent_status === `running` } )
            if( web_bridge ) {
                try {
                    await web_bridge.publish( {
                        output: clean_output,
                        activity: agent_status,
                        busy: action_busy || !!control_bridge?.applying || !input_allowed(),
                    } )
                    // Polls reserve input briefly; leave web requests queued rather
                    // than claiming and rejecting them during an empty poll.
                    if( !control_bridge?.busy ) {
                        const bridge_result = await web_bridge.process_requests( { busy: action_busy || !input_allowed() } )
                        bridge_sent = bridge_result.sent
                    }
                } catch ( error ) {
                    log.debug( `Web bridge tick failed for ${ session_name }: ${ error.message }` )
                }
            }

            if( bridge_sent ) {
                on_user_input?.()
                watchdog?.restart()
                idle_tracker.reset()
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // A long action can finish while this tick is awaiting tmux or
            // bridge I/O. Reset before evaluating the captured pre-finish
            // screen so it cannot immediately trigger another rule.
            if( reset_after_action || control_bridge && control_bridge.revision !== control_revision ) {
                idle_tracker.reset()
                control_revision = control_bridge?.revision || 0
                reset_after_action = false
                action_task = null
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            if( action_busy || control_bridge?.busy || !input_allowed() ) {
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // Evaluate rules in order — first match wins
            const now = Date.now()

            // A stalled verdict outranks rules: the stretch it judged is still quiet
            const watchdog_text = await watchdog?.take( agent_status )
            if( watchdog_text ) {
                watchdog_rule.do = watchdog_text
                begin_action( watchdog_rule, now )
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            const context = { output: clean_output, idle_seconds, config }

            for( const rule of rules ) {

                if( rule.on.type === `idle` && agent_status === `waiting` ) continue
                if( !should_fire_rule( rule, context, now ) ) continue

                begin_action( rule, now )

                // First match wins — stop evaluating further rules
                break

            }

            await wait_fn( POLL_INTERVAL_MS )

        }
    } finally {
        await finish_action()
        if( control_bridge ) await control_bridge.close()
        if( web_bridge ) await web_bridge.close()
    }

}
