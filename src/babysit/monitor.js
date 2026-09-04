import { wait } from 'mentie'
import { log } from '../utils/log.js'
import { capture_pane } from '../tmux/capture.js'
import { has_session, kill_session, set_agent_status } from '../tmux/session.js'
import { IdleTracker, strip_ansi, evaluate_rule } from './matcher.js'
import { execute_action } from './actions.js'
import { extract_session_id } from '../sessions/extract.js'
import { write_loop_deadline } from '../statusline/render.js'

// Poll interval for pane capture
const POLL_INTERVAL_MS = 1_000
const ACTIVITY_IDLE_SECONDS = 1
export const AGENT_EXIT_SENTINEL = `__BABYSIT_AGENT_EXIT__`
const log_shutdown_timing = message => process.env.BABYSIT_DEBUG === `1`
    ? log.info( message )
    : log.debug( message )

// Debounce between consecutive fires of the same rule (sir-claudius lesson: redraw flicker)
export const DEBOUNCE_MS = 3_000

/**
 * Convert pane stability into a list status.
 * @param {number} idle_seconds - Seconds since pane output last changed
 * @returns {'idle'|'running'} Current coding-agent activity
 */
export const agent_status_for_idle = ( idle_seconds ) => {

    // One complete unchanged poll means the viewport has stopped moving.
    // Supervision timeouts remain separate: they decide when rules fire.
    return idle_seconds >= ACTIVITY_IDLE_SECONDS ? `idle` : `running`

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
 * @param {'idle'|'running'} options.agent_status - Newly observed activity
 * @param {'idle'|'running'|null} options.last_agent_status - Last published activity
 * @param {Function} [options.publish=set_agent_status] - Tmux publisher seam
 * @returns {Promise<'idle'|'running'|null>} Last successfully published activity
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
 * Decide whether a rule should fire on this tick. Mutates `rule.first_matched_at`
 * to track when the match condition first became true; the monitor calls this
 * once per rule per tick, in order, and fires the first one to return true.
 *
 * Splitting this out of the monitor loop lets us unit-test the gate logic
 * (debounce + first-match timing) without standing up a tmux session.
 *
 * @param {Object} rule - Parsed rule with on/timeout_s/last_fired_at/first_matched_at
 * @param {Object} context - { output, idle_seconds, agent_patterns, config }
 * @param {number} now - `Date.now()` for this tick
 * @returns {boolean} True if the action should fire this tick
 */
export const should_fire_rule = ( rule, context, now ) => {

    // Per-rule debounce — suppresses TUI redraw flicker from re-firing the same rule
    if( now - rule.last_fired_at < DEBOUNCE_MS ) return false

    const matches = evaluate_rule( rule, context )

    // Match went false → re-arm the visibility timer so a flapping pattern
    // doesn't get credit for past matches it isn't currently in.
    if( !matches ) {
        rule.first_matched_at = null
        return false
    }

    // For idle rules, evaluate_rule already gates on idle_seconds — no extra
    // visibility check needed. For all other rule types, the spec says the
    // match must be the latest seen output FOR LONGER THAN THE TIMEOUT, which
    // means timing the persistence of the match itself, not whole-pane idle.
    if( rule.on.type !== `idle` && rule.timeout_s ) {

        if( !rule.first_matched_at ) {
            rule.first_matched_at = now
            return false
        }

        const elapsed_s = ( now - rule.first_matched_at ) / 1_000
        if( elapsed_s < rule.timeout_s ) return false

    }

    return true

}

/**
 * Start the babysit monitoring loop
 * Watches a tmux session and executes babysit.yaml rules based on output
 * @param {Object} options
 * @param {string} options.session_name - Tmux session name
 * @param {Object} options.config - Parsed babysit config
 * @param {Array} options.rules - Parsed babysit rules
 * @param {Object} options.agent_patterns - Agent-specific plan/choice patterns
 * @param {Object} options.agent - Agent adapter
 * @param {Object|null} [options.web_bridge] - Optional filesystem bridge controller
 * @param {Function} [options.on_session_id] - Callback when agent session ID is captured
 * @param {Function} [options.on_exit] - Callback when session ends
 * @returns {Promise<void>}
 */
export const start_monitor = async ( {
    session_name,
    config,
    rules,
    agent_patterns,
    agent,
    web_bridge = null,
    on_session_id,
    on_exit,
    agent_exit_sentinel = null,
    has_session_fn = has_session,
    capture_pane_fn = capture_pane,
    kill_session_fn = kill_session,
    publish_agent_status_fn = publish_agent_status,
    execute_action_fn = execute_action,
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
    const agent_target = web_bridge?.tmux_target || session_name

    const begin_action = ( rule, now ) => {

        log.info( `Rule matched: on=${ rule.on.type }${ rule.on.value ? ` (${ rule.on.value })` : `` }` )
        rule.last_fired_at = now
        rule.first_matched_at = null
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
    const idle_timeout_s = idle_rule?.timeout_s || config.idle_timeout_s

    log.info( `Monitoring session: ${ session_name }` )
    log.debug( `${ rules.length } rules loaded, polling every ${ POLL_INTERVAL_MS }ms` )

    try {

        while( true ) {

            if( reset_after_action ) {
                idle_tracker.reset()
                reset_after_action = false
                action_task = null
            }

            // Check if session is still alive
            const alive = await has_session_fn( session_name )
            if( !alive ) {
                log.info( `Session ended: ${ session_name }` )
                write_loop_deadline_fn( `idle` )
                await finish_action()
                if( on_exit ) await on_exit()
                break
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
            const agent_status = agent_status_for_idle( idle_seconds )

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
                const deadline = idle_tracker.get_deadline( idle_timeout_s )
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
                if( on_exit ) await on_exit()
                break
            }

            // Publish first, then claim a bounded request batch. An in-flight
            // Babysit action keeps ownership of the pane and rejects web input
            // explicitly instead of interleaving keystrokes.
            let bridge_sent = false
            if( web_bridge ) {
                try {
                    await web_bridge.publish( {
                        output: clean_output,
                        activity: agent_status,
                        busy: action_busy,
                    } )
                    const bridge_result = await web_bridge.process_requests( { busy: action_busy } )
                    bridge_sent = bridge_result.sent
                } catch ( error ) {
                    log.debug( `Web bridge tick failed for ${ session_name }: ${ error.message }` )
                }
            }

            if( bridge_sent ) {
                idle_tracker.reset()
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // A long action can finish while this tick is awaiting tmux or
            // bridge I/O. Reset before evaluating the captured pre-finish
            // screen so it cannot immediately trigger another rule.
            if( reset_after_action ) {
                idle_tracker.reset()
                reset_after_action = false
                action_task = null
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            if( action_busy ) {
                await wait_fn( POLL_INTERVAL_MS )
                continue
            }

            // Evaluate rules in order — first match wins
            const now = Date.now()
            const context = { output: clean_output, idle_seconds, agent_patterns, config }

            for( const rule of rules ) {

                if( !should_fire_rule( rule, context, now ) ) continue

                begin_action( rule, now )

                // First match wins — stop evaluating further rules
                break

            }

            await wait_fn( POLL_INTERVAL_MS )

        }
    } finally {
        await finish_action()
        if( web_bridge ) await web_bridge.close()
    }

}
