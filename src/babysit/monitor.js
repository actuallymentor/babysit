import { wait } from 'mentie'
import { log } from '../utils/log.js'
import { capture_pane } from '../tmux/capture.js'
import { has_session } from '../tmux/session.js'
import { IdleTracker, strip_ansi, evaluate_rule } from './matcher.js'
import { execute_action } from './actions.js'
import { extract_session_id } from '../sessions/extract.js'

// Poll interval for pane capture
const POLL_INTERVAL_MS = 1_000

// Debounce between consecutive fires of the same rule (sir-claudius lesson: redraw flicker)
const DEBOUNCE_MS = 3_000

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

    log.info( `Monitoring session: ${ session_name }` )
    log.debug( `${ rules.length } rules loaded, polling every ${ POLL_INTERVAL_MS }ms` )

    while( true ) {

        // Check if session is still alive
        const alive = await has_session( session_name )
        if( !alive ) {
            log.info( `Session ended: ${ session_name }` )
            if( on_exit ) on_exit()
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

            // Skip if debounce period hasn't elapsed
            if( now - rule.last_fired_at < DEBOUNCE_MS ) continue

            // Check timeout override — for non-idle rules, require the output to be "stable"
            // meaning the match has been visible for at least timeout_s seconds
            if( rule.on.type !== `idle` && rule.timeout_s ) {
                if( idle_seconds < rule.timeout_s ) continue
            }

            if( evaluate_rule( rule, context ) ) {

                log.info( `Rule matched: on=${ rule.on.type }${ rule.on.value ? ` (${ rule.on.value })` : `` }` )
                rule.last_fired_at = now

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

        }

        await wait( POLL_INTERVAL_MS )

    }

}
