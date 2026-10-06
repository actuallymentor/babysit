import { log } from '../utils/log.js'

// Every supported agent quits on this slash command from an idle composer.
export const EXIT_COMMAND = `/exit`
export const EXIT_FALLBACK_MS = 30_000

/**
 * Graceful session exit requested from inside the container (`babysit exit`).
 * The session is marked intentionally closed first so recovery never
 * relaunches it, the agent is asked to quit once its composer is idle so a
 * running turn can finish, and a forced close follows if it never does.
 * The entrypoint's exit sentinel then drives the monitor's normal cleanup.
 * @param {Object} session - Session record identity
 * @param {Object} options
 * @param {Function} options.send_text - Type into the agent pane (adds Enter)
 * @param {Function} options.update - Session record writer
 * @param {Function} options.force_close - Forced close when the agent ignores the command
 * @param {Function} [options.set_timer] - Timer seam
 * @param {Function} [options.clear_timer] - Timer seam
 * @param {number} [options.fallback_ms] - Grace period before forcing
 * @returns {{ request: Function, on_status: Function, stop: Function, requested: boolean }}
 */
export const create_exit_controller = ( session, {
    send_text,
    update,
    force_close,
    set_timer = setTimeout,
    clear_timer = clearTimeout,
    fallback_ms = EXIT_FALLBACK_MS,
} ) => {

    let requested = false
    let sent = false
    let timer = null

    const force = async () => {
        timer = null
        log.warn( `Agent did not exit within ${ fallback_ms / 1_000 }s; closing the session` )
        try {
            await force_close( session )
        } catch ( error ) {
            log.error( `Forced close failed: ${ error.message }` )
        }
    }

    return {

        get requested() {
            return requested
        },

        /** Record the intent. Returns the message shown to the caller. */
        request: () => {
            if( !requested ) {
                requested = true
                update( session.babysit_id, { expected_open: false, close_reason: `agent`, closed_at: new Date().toISOString() } )
                timer = set_timer( force, fallback_ms )
                timer?.unref?.()
            }
            return `Exiting after the current turn finishes.`
        },

        /** Send the quit command the first time the agent is idle. */
        on_status: async status => {
            if( !requested || sent || status === `running` ) return
            sent = true
            log.info( `Agent idle; sending ${ EXIT_COMMAND }` )
            await send_text( session.pane_id || session.tmux_session, EXIT_COMMAND )
        },

        stop: () => {
            if( timer ) clear_timer( timer )
            timer = null
        },

    }

}
