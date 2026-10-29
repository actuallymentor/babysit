import { log } from '../utils/log.js'

// Every supported agent quits on this slash command from an idle composer.
export const EXIT_COMMAND = `/exit`

// Grace period after the first /exit before the session is forced closed
export const EXIT_FALLBACK_MS = 30_000

// Longest wait for the requesting turn to end before /exit is ever sent
export const EXIT_TURN_LIMIT_MS = 10 * 60_000

// A forced close that fails is retried a few times, never silently dropped
export const FORCE_RETRY_MS = 15_000
export const FORCE_ATTEMPTS = 4

// Claude (2.1.310) answers /exit with a menu while background shells or tasks
// run; option 1 exits and stops them. A menu that outlives its keypress is
// pressed again after DIALOG_RETRY_MS.
const EXIT_DIALOG = /Background work is running[\s\S]*1\.\s*Exit and stop tasks/
const DIALOG_ANSWER = `1`
const DIALOG_RETRY_MS = 5_000

/**
 * Whether the screen shows the agent's "stop background work?" exit menu.
 * @param {string} screen - ANSI-stripped pane text
 * @returns {boolean}
 */
export const is_exit_dialog = screen => EXIT_DIALOG.test( screen || `` )

/**
 * Graceful session exit requested from inside the container (`babysit exit`).
 * The session is marked intentionally closed first so recovery never
 * relaunches it, the agent is asked to quit once its composer is idle so a
 * running turn can finish, an exit confirmation menu is answered, and a
 * forced close follows if the agent still has not quit.
 * The entrypoint's exit sentinel then drives the monitor's normal cleanup.
 * @param {Object} session - Session record identity
 * @param {Object} options
 * @param {Function} options.send_text - Type into the agent pane (adds Enter)
 * @param {Function} options.send_keys - Press keys in the agent pane
 * @param {Function} options.update - Session record writer
 * @param {Function} options.force_close - Forced close when the agent ignores the command
 * @param {Function} [options.set_timer] - Timer seam
 * @param {Function} [options.clear_timer] - Timer seam
 * @param {Function} [options.now] - Clock seam
 * @param {number} [options.fallback_ms] - Grace period after /exit before forcing
 * @param {number} [options.turn_limit_ms] - Grace period for the turn to end before forcing
 * @param {number} [options.retry_ms] - Delay between failed forced closes
 * @returns {{ request: Function, on_status: Function, stop: Function, requested: boolean }}
 */
export const create_exit_controller = ( session, {
    send_text,
    send_keys,
    update,
    force_close,
    set_timer = setTimeout,
    clear_timer = clearTimeout,
    now = Date.now,
    fallback_ms = EXIT_FALLBACK_MS,
    turn_limit_ms = EXIT_TURN_LIMIT_MS,
    retry_ms = FORCE_RETRY_MS,
} ) => {

    const target = session.pane_id || session.tmux_session

    let requested = false
    let sent = false
    let forcing = false
    let stopped = false
    let answered_at = -Infinity
    let attempts = 0
    let timer = null

    // One pending deadline at a time; a later stage replaces the earlier one
    const schedule = ( fn, ms ) => {
        if( timer ) clear_timer( timer )
        timer = set_timer( fn, ms )
        timer?.unref?.()
    }

    const force = async () => {

        timer = null
        forcing = true
        attempts++
        if( attempts === 1 ) log.warn( `Agent did not exit; closing the session` )

        try {
            await force_close( session )
        } catch ( error ) {
            if( stopped ) return
            if( attempts >= FORCE_ATTEMPTS ) {
                log.error( `Forced close failed ${ attempts } times, giving up: ${ error.message }` )
                return
            }
            log.warn( `Forced close failed (attempt ${ attempts }), retrying in ${ retry_ms / 1_000 }s: ${ error.message }` )
            schedule( force, retry_ms )
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
                schedule( force, turn_limit_ms )
            }
            return `Exiting after the current turn finishes.`
        },

        /** Send the quit command once idle, then answer its confirmation menu on `screen`. */
        on_status: async ( status, screen = `` ) => {

            if( !requested || forcing ) return

            // First idle tick: ask to quit; the grace period starts now
            if( !sent ) {
                if( status === `running` ) return
                sent = true
                schedule( force, fallback_ms )
                log.info( `Agent idle; sending ${ EXIT_COMMAND }` )
                await send_text( target, EXIT_COMMAND )
                return
            }

            // The menu's "Esc to cancel" hint reads as running, so any status counts.
            // A menu that survives a keypress gets pressed again, not every tick
            if( now() - answered_at < DIALOG_RETRY_MS || !is_exit_dialog( screen ) ) return

            answered_at = now()
            log.info( `Exit menu shown; choosing to exit and stop background work` )
            await send_keys( target, DIALOG_ANSWER )

        },

        stop: () => {
            stopped = true
            if( timer ) clear_timer( timer )
            timer = null
        },

    }

}
