import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'

/**
 * Send keystrokes to a tmux session
 * @param {string} session_name - The session name
 * @param {string[]} keys - The keys to send
 * @returns {Promise<void>}
 */
export const send_keys = async ( session_name, ...keys ) => {

    await run( `tmux`, [
        `-L`, TMUX_SOCKET,
        `send-keys`, `-t`, session_name,
        ...keys,
    ] )

}

/**
 * Send a text string followed by Enter
 * @param {string} session_name - The session name
 * @param {string} text - The text to type and submit
 * @returns {Promise<void>}
 */
export const send_text = async ( session_name, text ) => {

    log.debug( `Sending text to session: ${ text.slice( 0, 80 ) }...` )
    await send_keys( session_name, text, `Enter` )

}

/**
 * Send Enter key
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const send_enter = async ( session_name ) => {

    await send_keys( session_name, `Enter` )

}

/**
 * Send Shift+Tab (for claude plan acceptance)
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const send_shift_tab = async ( session_name ) => {

    // \x1b[Z is the escape sequence for Shift+Tab
    await send_keys( session_name, `\\x1b[Z` )

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
