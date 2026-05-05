import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'

const has_line_break = text => /[\r\n]/.test( text )

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
 * Paste multi-line text through tmux's paste buffer.
 * @param {string} session_name - The session name
 * @param {string} text - Text to paste
 * @param {Object} [options]
 * @param {Function} [options.runner=run] - Command runner, injected by tests
 * @returns {Promise<void>}
 */
const paste_multiline_text = async ( session_name, text, { runner = run } = {} ) => {

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
 * Single-line text uses tmux's `-l` flag so characters like `$`, `!`, and
 * backticks are passed through literally instead of being interpreted as tmux
 * key names.
 *
 * Multi-line text is pasted through a tmux buffer with bracketed paste enabled.
 * Without this, embedded newlines are delivered as real Enter key presses,
 * splitting a launch prompt into partial messages in TUI agents like Codex.
 *
 * @param {string} session_name - The session name
 * @param {string} text - The text to type and submit
 * @param {Object} [options]
 * @param {Function} [options.runner=run] - Command runner, injected by tests
 * @returns {Promise<void>}
 */
export const send_text = async ( session_name, text, { runner = run } = {} ) => {

    log.debug( `Sending text to session: ${ text.slice( 0, 80 ) }...` )

    if( has_line_break( text ) ) await paste_multiline_text( session_name, text, { runner } )
    else await run_tmux( runner, [ `send-keys`, `-t`, session_name, `-l`, text ] )

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
