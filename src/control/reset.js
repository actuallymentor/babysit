import { log } from '../utils/log.js'

// Let the agent act on the clear command before the composer is read again
const CLEAR_SETTLE_MS = 1_500

/**
 * `babysit reset`: clear the agent's context and type the configured initial
 * prompt again. Like `exit` it waits for the turn that asked for it to end,
 * since the agent itself usually runs the command mid-turn.
 * @param {Object} session - Session record identity
 * @param {Object} options
 * @param {string|null} options.clear_command - The agent's slash command for a fresh conversation
 * @param {Function} options.prompt - () => initial prompt text, empty for none
 * @param {Function} options.send_text - Type into the agent pane (adds Enter)
 * @param {Function} options.wait_ready - () => true once the composer accepts text
 * @param {Function} [options.wait] - Sleep seam
 * @param {number} [options.settle_ms] - Pause after the clear command
 * @returns {{ request: Function, on_status: Function, requested: boolean }}
 */
export const create_reset_controller = ( session, {
    clear_command,
    prompt,
    send_text,
    wait_ready,
    wait = ms => new Promise( resolve => setTimeout( resolve, ms ) ),
    settle_ms = CLEAR_SETTLE_MS,
} ) => {

    let requested = false

    const reset = async () => {

        const target = session.pane_id || session.tmux_session
        const text = await prompt()

        log.info( `Agent idle; resetting context with ${ clear_command }` )
        await send_text( target, clear_command )
        await wait( settle_ms )

        if( !text ) return log.info( `Reset done; no initial prompt configured` )
        if( !await wait_ready() ) return log.warn( `Reset: the composer never came back, initial prompt not sent` )

        await send_text( target, text )
        log.info( `Reset done; initial prompt sent` )

    }

    return {

        get requested() {
            return requested
        },

        /** Record the intent. Returns the message shown to the caller. */
        request: () => {
            if( !clear_command ) throw new Error( `babysit reset is not supported for this agent.` )
            requested = true
            return `Resetting after the current turn finishes: context clears and the initial prompt is sent again.`
        },

        /** Clear and re-prompt the first time the agent is idle after a request. */
        on_status: async status => {
            if( !requested || status !== `idle` ) return
            requested = false
            try {
                await reset()
            } catch ( error ) {
                log.error( `Reset failed: ${ error.message }` )
            }
        },

    }

}
