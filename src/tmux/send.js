import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'

const make_buffer_name = () => `babysit-send-${ process.pid }-${ Date.now() }-${ Math.random().toString( 36 ).slice( 2 ) }`

const run_tmux = ( runner, args ) => runner( `tmux`, [ `-L`, TMUX_SOCKET, ...args ] )

/**
 * Send keystrokes to a tmux session
 * @param {string} session_name - The session name
 * @param {string[]} keys - The keys to send
 * @returns {Promise<void>}
 */
export const send_keys = async ( session_name, ...keys ) => {

    await run_tmux( run, [ `send-keys`, `-t`, session_name, ...keys ] )

}

/**
 * Send Enter key
 * @param {string} session_name - The session name
 * @param {Object} [options]
 * @param {Function} [options.runner=run] - Command runner, injected by tests
 * @returns {Promise<void>}
 */
export const send_enter = async ( session_name, { runner = run } = {} ) => {

    await run_tmux( runner, [ `send-keys`, `-t`, session_name, `Enter` ] )

}

/**
 * Paste text through tmux's paste buffer.
 *
 * Using bracketed paste for single-line text matters for Codex: rapid
 * `send-keys -l` input followed immediately by Enter is treated as a
 * paste-like burst, and Codex turns that Enter into a newline instead of a
 * submit. An explicit paste event clears that suppression window.
 *
 * @param {string} session_name - The session name
 * @param {string} text - Text to paste
 * @param {Object} [options]
 * @param {Function} [options.runner=run] - Command runner, injected by tests
 * @returns {Promise<void>}
 */
const paste_text = async ( session_name, text, { runner = run } = {} ) => {

    const buffer_name = make_buffer_name()

    await run_tmux( runner, [ `set-buffer`, `-b`, buffer_name, text ] )

    try {
        await run_tmux( runner, [ `paste-buffer`, `-pr`, `-d`, `-b`, buffer_name, `-t`, session_name ] )
    } catch ( e ) {
        await run_tmux( runner, [ `delete-buffer`, `-b`, buffer_name ] ).catch( () => null )
        throw e
    }

}

/**
 * Send a text string followed by Enter.
 *
 * Text is pasted through a tmux buffer with bracketed paste enabled. Without
 * this, embedded newlines are delivered as real Enter key presses, splitting a
 * launch prompt into partial messages in TUI agents like Codex. It also avoids
 * Codex's paste-burst heuristic swallowing the final Enter for single-line
 * prompts like the default loop action.
 *
 * @param {string} session_name - The session name
 * @param {string} text - The text to type and submit
 * @param {Object} [options]
 * @param {Function} [options.runner=run] - Command runner, injected by tests
 * @returns {Promise<void>}
 */
export const send_text = async ( session_name, text, { runner = run } = {} ) => {

    log.debug( `Sending text to session: ${ text.slice( 0, 80 ) }...` )

    await paste_text( session_name, text, { runner } )

    await send_enter( session_name, { runner } )

}

/**
 * Send Shift+Tab (for claude plan acceptance — \x1b[Z escape sequence).
 * tmux send-keys recognises BTab as the canonical name for back-tab.
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const send_shift_tab = async ( session_name ) => {

    await send_keys( session_name, `BTab` )

}

/**
 * Send Ctrl+C
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const send_ctrl_c = async ( session_name ) => {

    await send_keys( session_name, `C-c` )

}

/**
 * Send Escape key
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const send_escape = async ( session_name ) => {

    await send_keys( session_name, `Escape` )

}
