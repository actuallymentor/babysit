import { wait } from 'mentie'
import { log } from '../utils/log.js'
import { capture_pane } from '../tmux/capture.js'
import { has_session } from '../tmux/session.js'
import { IdleTracker, strip_ansi, evaluate_rule } from './matcher.js'
import { execute_action } from './actions.js'
import { extract_session_id } from '../sessions/extract.js'
import { write_loop_deadline } from '../statusline/render.js'

// Poll interval for pane capture
const POLL_INTERVAL_MS = 1_000

// Debounce between consecutive fires of the same rule (sir-claudius lesson: redraw flicker)
export const DEBOUNCE_MS = 3_000

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
 * @param {Function} [options.on_session_id] - Callback when agent session ID is captured
 * @param {Function} [options.on_exit] - Callback when session ends
 * @returns {Promise<void>}
 */
export const start_monitor = async ( { session_name, config, rules, agent_patterns, agent, on_session_id, on_exit } ) => {

    const idle_tracker = new IdleTracker()
    let session_id_captured = false
    let last_written_deadline = null

    // Find the idle rule once — used to publish the countdown for the statusline
    const idle_rule = rules.find( r => r.on.type === `idle` )
    const idle_timeout_s = idle_rule?.timeout_s || config.idle_timeout_s

    log.info( `Monitoring session: ${ session_name }` )
    log.debug( `${ rules.length } rules loaded, polling every ${ POLL_INTERVAL_MS }ms` )

    while( true ) {

        // Check if session is still alive
        const alive = await has_session( session_name )
        if( !alive ) {
            log.info( `Session ended: ${ session_name }` )
            write_loop_deadline( `idle` )
            if( on_exit ) await on_exit()
            break
        }

        // Capture pane output
        let raw_output
        try {
            raw_output = await capture_pane( session_name )
        } catch {
            log.debug( `Failed to capture pane, session may be closing` )
            await wait( POLL_INTERVAL_MS )
            continue
        }

        // Clean ANSI sequences
        const clean_output = strip_ansi( raw_output )

        // Track idle state
        const idle_seconds = idle_tracker.update( clean_output )

        // Publish the idle countdown deadline for the statusline (only when it changes)
        if( idle_rule ) {
            const deadline = idle_tracker.get_deadline( idle_timeout_s )
            if( deadline !== null && deadline !== last_written_deadline ) {
                write_loop_deadline( deadline )
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

        // Evaluate rules in order — first match wins
        const now = Date.now()
        const context = { output: clean_output, idle_seconds, agent_patterns, config }

        for( const rule of rules ) {

            if( !should_fire_rule( rule, context, now ) ) continue

            log.info( `Rule matched: on=${ rule.on.type }${ rule.on.value ? ` (${ rule.on.value })` : `` }` )
            rule.last_fired_at = now
            rule.first_matched_at = null  // re-arm for the next cycle

            try {
                await execute_action( session_name, rule.do, config )
            } catch ( e ) {
                log.error( `Action failed: ${ e.message }` )
            }

            // Reset idle tracker after firing an action (we just sent input)
            idle_tracker.reset()

            // First match wins — stop evaluating further rules
            break

        }

        await wait( POLL_INTERVAL_MS )

    }

}
