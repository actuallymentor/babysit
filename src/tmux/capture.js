import { promise_timeout } from 'mentie'
import { run } from '../utils/exec.js'
import { TMUX_SOCKET } from '../utils/paths.js'

/**
 * Capture the current visible pane content of a tmux session
 * @param {string} session_name - The session name
 * @param {number} [timeout_ms=5000] - Timeout in milliseconds
 * @returns {Promise<string>} The pane content
 */
export const capture_pane = async ( session_name, timeout_ms = 5_000 ) => {

    const task = run( `tmux`, [
        `-L`, TMUX_SOCKET,
        `capture-pane`, `-t`, session_name,
        `-p`,
    ] )

    return promise_timeout( task, timeout_ms )

}

/**
 * Capture the last N lines of scrollback history
 * @param {string} session_name - The session name
 * @param {number} [lines=100] - Number of lines to capture
 * @returns {Promise<string>} The captured output
 */
export const capture_history = async ( session_name, lines = 100 ) => {

    return run( `tmux`, [
        `-L`, TMUX_SOCKET,
        `capture-pane`, `-t`, session_name,
        `-p`, `-S`, `-${ lines }`,
    ] )

}
