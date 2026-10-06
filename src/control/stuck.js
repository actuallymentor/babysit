import { run } from '../utils/exec.js'
import { TMUX_SOCKET } from '../utils/paths.js'

const CLIENT_POLL_MS = 5_000

/**
 * Newest keypress time across the clients attached to a tmux session.
 * `client_activity` only moves on client input, never on pane output or
 * send-keys, so it separates the user typing from the monitor's own typing.
 * @param {string} session_name - Tmux session
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @returns {Promise<number|null>} Epoch milliseconds, or null without clients
 */
export const last_client_activity = async ( session_name, { run_command = run } = {} ) => {

    try {
        const output = await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `list-clients`, `-t`, session_name, `-F`, `#{client_activity}` ], {}, 5_000 )
        const times = output.split( `\n` ).map( Number ).filter( value => Number.isFinite( value ) && value > 0 )
        return times.length ? Math.max( ...times ) * 1_000 : null
    } catch {
        return null
    }

}

/**
 * `babysit stuck`: the agent flags that it is blocked. The flag lives on the
 * session record so `babysit list` shows "stuck", and clears as soon as the
 * user types into that tmux session or sends input through the web companion.
 * @param {Object} session - Session record identity
 * @param {Object} options
 * @param {Function} options.update - Session record writer
 * @param {Function} [options.client_activity] - Keypress time reader seam
 * @param {Function} [options.now] - Clock seam
 * @param {number} [options.poll_ms] - Spacing between client checks while stuck
 * @returns {{ request: Function, tick: Function, clear: Function, stuck: boolean }}
 */
export const create_stuck_controller = ( session, {
    update,
    client_activity = last_client_activity,
    now = Date.now,
    poll_ms = CLIENT_POLL_MS,
} ) => {

    let stuck_at = session.stuck_at ? Date.parse( session.stuck_at ) : null
    let next_check = 0

    const clear = () => {
        if( stuck_at === null ) return
        stuck_at = null
        update( session.babysit_id, { stuck_at: null } )
    }

    return {

        get stuck() {
            return stuck_at !== null
        },

        /** Flag the session; repeated calls keep the original time. */
        request: () => {
            if( stuck_at === null ) {
                stuck_at = now()
                update( session.babysit_id, { stuck_at: new Date( stuck_at ).toISOString() } )
            }
            return `Session marked stuck; it clears when the user types into it.`
        },

        /** Poll attached clients for typing after the flag was raised. */
        tick: async () => {
            if( stuck_at === null || now() < next_check ) return
            next_check = now() + poll_ms
            const typed_at = await client_activity( session.tmux_session )
            if( typed_at !== null && typed_at > stuck_at ) clear()
        },

        clear,

    }

}
