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

/**
 * Start streaming the pane's output to a file via `tmux pipe-pane`. tmux runs
 * the shell command on its own server, which keeps writing as long as the
 * session lives — so logging survives Ctrl+B d, container restarts inside the
 * pane, and the foreground cli detaching to its monitor daemon.
 *
 * The path is single-quoted in the shell command so spaces / special chars are
 * tolerated. tmux pipe-pane writes RAW pane output, including ANSI escape
 * sequences for color and cursor motion. Strip them post-hoc with e.g.
 * `sed -E 's/\\x1B\\[[0-9;?]*[a-zA-Z]//g' < log` if you want a plain-text view.
 *
 * @param {string} session_name - Tmux session to attach the pipe to
 * @param {string} log_path - Absolute path on the host (created if missing)
 * @returns {Promise<string>} tmux stdout (typically empty on success)
 */
export const start_pipe_pane = async ( session_name, log_path ) => {

    const escaped = log_path.replace( /'/g, `'\\''` )

    return run( `tmux`, [
        `-L`, TMUX_SOCKET,
        `pipe-pane`, `-t`, session_name,
        `cat >> '${ escaped }'`,
    ] )

}
