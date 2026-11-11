import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, writeFileSync } from 'fs'
import { command_exists, run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'
import { WRAPPER_ENV } from '../utils/wrapper_env.js'
import { start_pipe_pane } from './capture.js'

const AGENT_STATUS_OPTION = `@babysit_agent_status`
// Epoch seconds: start of the current idle stretch, and of an unseen one
const IDLE_OPTION = `@babysit_idle_since`
const UNREAD_OPTION = `@babysit_unread_since`
const SHELVED_OPTION = `@babysit_shelved_since`
// Idle rules: epoch seconds of the next automated turn while idle, else the activity word
const NEXT_TURN_OPTION = `@babysit_next_turn`

/**
 * Generate a tmux session name following the babysit convention
 * @param {string} pwd - Current working directory
 * @param {string} agent_name - Name of the coding agent
 * @returns {string} Session name: babysit_<pwd>_<agent>_<timestamp>
 */
export const make_session_name = ( pwd, agent_name ) => {

    const timestamp = Date.now()
    let path_segment = pwd.replace( /\./g, `__DOT__` ).replace( /:/g, `__CLN__` )

    // Hash long paths to avoid tmux name limits (~256 chars)
    if( path_segment.length > 200 ) {
        const path_hash = createHash( `sha256` ).update( pwd ).digest( `hex` ).slice( 0, 16 )
        const basename = pwd.split( `/` ).pop()
        path_segment = `${ basename }__${ path_hash }`
    }

    return `babysit_${ path_segment }_${ agent_name }_${ timestamp }`

}

/**
 * Write the bottom-bar identity label; the monitor rewrites it when flags change.
 * @param {string} session_name - Tmux session
 * @param {string} status_label - Literal label text
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 */
export const set_status_label = async ( session_name, status_label, { run_command = run } = {} ) => {

    await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `@babysit_status_label`, status_label ] )
    // Tmux measures this limit in terminal columns. Two columns per UTF-16
    // code unit safely covers CJK and emoji labels.
    await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-left-length`, String( status_label.length * 2 + 1 ) ] )

}

/**
 * Create a new detached tmux session with babysit defaults.
 * The `command` is passed verbatim to `sh -c`, so callers must shell-quote
 * any embedded values (see docker/run.js#shell_quote).
 * @param {string} session_name - The session name
 * @param {string} command - Pre-quoted shell command to run inside the session
 * @param {Object} [options]
 * @param {string|null} [options.log_path] - Optional host path for pipe-pane logging
 * @param {string|null} [options.startup_log_path] - Optional short-lived startup diagnostic log path
 * @param {string|null} [options.status_label] - Literal session identity for the bottom status bar
 * @param {Function} [options.run_command] - Injectable command runner
 * @param {string|null} [options.clipboard] - Host clipboard command for drag-to-copy
 * @returns {Promise<{pipe_started: boolean}>}
 */
/**
 * Pick the host tool that puts text on the system clipboard. Null means rely
 * on tmux's own OSC 52 forwarding (set-clipboard), which most terminals honour.
 * @param {Object} [options]
 * @param {string} [options.platform] - process.platform seam
 * @param {Object} [options.env] - Environment seam
 * @param {Function} [options.exists] - PATH lookup seam
 * @returns {string|null} Shell command reading stdin, or null
 */
export const clipboard_command = ( {
    platform = process.platform,
    env = process.env,
    exists = command_exists,
} = {} ) => {

    // xclip and xsel keep stdout open and would stall tmux's key handling
    // without the redirect (tmux wiki, "Clipboard"). Both need an X display.
    const candidates = platform === `darwin`
        ? [ `pbcopy` ]
        : [
            ...env.WAYLAND_DISPLAY ? [ `wl-copy` ] : [],
            ...env.DISPLAY ? [ `xclip -selection clipboard >/dev/null`, `xsel --clipboard --input >/dev/null` ] : [],
        ]

    return candidates.find( candidate => exists( candidate.split( ` ` )[0] ) ) || null

}

/**
 * Mouse mode makes tmux own the drag, so terminals only select natively with
 * Option/Shift held. Keep scroll-wheel scrollback, but make a plain drag copy
 * to the system clipboard and leave copy mode, like a normal terminal.
 * @param {Function} run_command - Command runner
 * @param {string|null} clipboard - Host clipboard command, or null for OSC 52 only
 */
const configure_mouse_copy = async ( run_command, clipboard ) => {

    const on_drag_end = clipboard
        ? [ `copy-pipe-and-cancel`, clipboard ]
        : [ `copy-selection-and-cancel` ]

    await Promise.all( [
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-s`, `set-clipboard`, `on` ] ),
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `bind-key`, `-T`, `copy-mode`, `MouseDragEnd1Pane`, `send-keys`, `-X`, ...on_drag_end ] ),
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `bind-key`, `-T`, `copy-mode-vi`, `MouseDragEnd1Pane`, `send-keys`, `-X`, ...on_drag_end ] ),
    ] )

}

export const create_session = async ( session_name, command, {
    log_path = null,
    startup_log_path = null,
    status_label = null,
    run_command = run,
    clipboard = clipboard_command(),
} = {} ) => {

    const pipe_log_path = log_path || startup_log_path

    const boot_shell = [
        `read _`,
        `boot_command="$1"`,
        `exec sh -c "$boot_command"`,
    ].join( `; ` )
    const session_command = pipe_log_path
        ? [ `sh`, `-c`, boot_shell, `sh`, command ]
        : [ `sh`, `-c`, command ]

    await run_command( `tmux`, [
        `-L`, TMUX_SOCKET,
        `new-session`, `-d`,
        `-s`, session_name,
        `-x`, `220`, `-y`, `50`,
        ...session_command,
    ] )

    // Configure session defaults
    await Promise.all( [
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `-g`, `history-limit`, `10000` ] ),
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `-g`, `mouse`, `on` ] ),
        run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, AGENT_STATUS_OPTION, `running` ] ),
    ] )

    // Cosmetic: a failed binding must not stop the launch.
    try {
        await configure_mouse_copy( run_command, clipboard )
    } catch ( error ) {
        log.debug( `Could not configure mouse copy: ${ error.message }` )
    }

    if( status_label ) {
        try {
            await Promise.all( [
                set_status_label( session_name, status_label, { run_command } ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status`, `on` ] ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-position`, `bottom` ] ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-left`, `#[bold]#{@babysit_status_label}#[default] ` ] ),
            ] )
        } catch ( error ) {
            log.warn( `Could not configure the tmux status bar: ${ error.message }` )
        }
    }

    let pipe_started = false

    if( pipe_log_path ) {

        try {
            await start_pipe_pane( session_name, pipe_log_path )
            pipe_started = true
        } catch ( e ) {
            log.warn( `Could not start pipe-pane logging: ${ e.message }` )
        }

        // Release the boot shell only after pipe-pane has had a chance to
        // attach, otherwise fast startup output can escape diagnostics. The
        // real command is held as a shell argument so it is not echoed into
        // the user's terminal/log.
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `send-keys`, `-t`, session_name, `Enter` ] )

    }

    log.info( `Created tmux session: ${ session_name }` )

    return { pipe_started }

}

/**
 * Check if a tmux session is still alive
 * @param {string} session_name - The session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<boolean>}
 */
export const has_session = async ( session_name, { run_command = run } = {} ) => {

    try {
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `has-session`, `-t`, `=${ session_name }` ] )
        return true
    } catch {
        return false
    }

}

/**
 * Kill a tmux session
 * @param {string} session_name - The session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<void>}
 */
export const kill_session = async ( session_name, { run_command = run } = {} ) => {

    try {
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `kill-session`, `-t`, `=${ session_name }` ] )
        log.info( `Killed tmux session: ${ session_name }` )
    } catch {
        log.debug( `Session already gone: ${ session_name }` )
    }

}

// In-process attaches this run; once one returns, the user detached or the session closed
let foreground_attaches = 0

/** @returns {number} Attaches that blocked in this process and have since returned */
export const foreground_attach_count = () => foreground_attaches

/**
 * Attach to an existing tmux session. Under the shell-init wrapper the shell
 * runs `tmux attach` itself: a babysit process blocked for the whole session
 * gets swapped out on a busy host, and paging it back in delays every detach.
 * @param {string} session_name - The session name
 * @param {Object} [options]
 * @param {Function} [options.exec_command] - Injectable synchronous command runner
 * @param {Object} [options.env] - Environment carrying BABYSIT_ATTACH_FILE
 * @param {Function} [options.write_file] - File writer seam
 * @returns {boolean} true once the foreground client exits, false when the wrapper attaches instead
 */
export const attach_session = ( session_name, { exec_command = execSync, env = WRAPPER_ENV, write_file = writeFileSync } = {} ) => {

    // Only the wrapper's own temp file, so a stale inherited variable never creates one
    const attach_file = env.BABYSIT_ATTACH_FILE
    if( attach_file && existsSync( attach_file ) ) {
        write_file( attach_file, `${ TMUX_SOCKET }\n=${ session_name }\n` )
        return false
    }

    try {
        exec_command( `tmux -L ${ TMUX_SOCKET } attach -t ${ JSON.stringify( `=${ session_name }` ) }`, {
            stdio: `inherit`,
        } )
    } catch ( error ) {
        // Tmux can exit non-zero after a normal detach; that is not a failure.
        log.debug( `tmux attach exited: ${ error.message }` )
    }

    foreground_attaches++
    return true

}

/**
 * Publish coding-agent activity on its tmux session for `babysit list`.
 * @param {string} session_name - Babysit tmux session name
 * @param {'idle'|'running'|'waiting'} status - Current coding-agent activity
 * @param {Object} [options] - Command runner seam
 * @returns {Promise<boolean>} Whether tmux accepted the update
 */
export const set_agent_status = async ( session_name, status, { run_command = run } = {} ) => {

    try {
        // Older tmux set-option requires target-pane syntax for this exact
        // session reference; the bare '=session' form fails in a detached monitor.
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, `=${ session_name }:`, AGENT_STATUS_OPTION, status ] )
        return true
    } catch ( error ) {
        log.debug( `Could not publish ${ session_name } agent status: ${ error.message }` )
        return false
    }

}

/**
 * Publish when an idle rule (`on: idle`, `--loop`) sends its next turn, for
 * `babysit watch`. The global loop-deadline file only serves the statusline
 * inside one container; this one is per session.
 * @param {string} session_name - Babysit tmux session name
 * @param {number|string} value - Epoch seconds while idle, else the activity word
 * @param {Object} [options] - Command runner seam
 * @returns {Promise<boolean>} Whether tmux accepted the update
 */
export const set_next_turn = async ( session_name, value, { run_command = run } = {} ) => {

    try {
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, `=${ session_name }:`, NEXT_TURN_OPTION, String( value ) ] )
        return true
    } catch ( error ) {
        log.debug( `Could not publish ${ session_name } next turn: ${ error.message }` )
        return false
    }

}

/**
 * Resolve the single pane owned by a Babysit session.
 *
 * The leading `=` makes tmux require an exact session-name match. The returned
 * pane id is then safe to use as the input target even when another session
 * happens to share a name prefix.
 *
 * @param {string} session_name - Exact Babysit tmux session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<{ pane_id: string, attachment: 'attached'|'detached' }>}
 */
export const get_session_pane = async ( session_name, { run_command = run } = {} ) => {

    const exact_target = `=${ session_name }:`
    const output = await run_command( `tmux`, [
        `-L`, TMUX_SOCKET,
        `display-message`, `-p`, `-t`, exact_target,
        `#{pane_id}:#{?session_attached,attached,detached}`,
    ] )
    const [ pane_id, attachment ] = output.trim().split( `:` )

    if( !/^%\d+$/.test( pane_id ) || ![ `attached`, `detached` ].includes( attachment ) ) {
        throw new Error( `Could not resolve an exact tmux pane for ${ session_name }` )
    }

    return { pane_id, attachment }

}

/**
 * Read whether an exact tmux session currently has an attached client.
 * @param {string} session_name - Exact Babysit tmux session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<'attached'|'detached'>}
 */
export const get_session_attachment = async ( session_name, { run_command = run } = {} ) => {

    const output = await run_command( `tmux`, [
        `-L`, TMUX_SOCKET,
        `display-message`, `-p`, `-t`, `=${ session_name }:`,
        `#{?session_attached,attached,detached}`,
    ] )
    const attachment = output.trim()

    if( ![ `attached`, `detached` ].includes( attachment ) ) {
        throw new Error( `Could not read tmux attachment state for ${ session_name }` )
    }

    return attachment

}

/**
 * Stamp the start of an idle stretch. A finished turn stamps `@babysit_idle_since`
 * and `@babysit_unread_since`, attached or not: an open terminal is not proof
 * anyone read it. `list_sessions` reads unread until a human touches the session
 * (see `is_unread`). A monitor's first look at an idle agent (start, recovery)
 * only stamps idle-since when none is set (`-o`), so restarts neither reset
 * the age nor mark anything unread. Cosmetic: failures are only logged.
 * @param {string} session_name - Babysit tmux session name
 * @param {Object} [options]
 * @param {boolean} [options.finished=true] - Whether a turn just ended (vs a first observation)
 * @param {Function} [options.run_command=run] - Command runner seam
 * @param {Function} [options.now=Date.now] - Clock seam
 * @returns {Promise<boolean>} Whether the session was marked unread
 */
export const mark_idle = async ( session_name, { finished = true, run_command = run, now = Date.now } = {} ) => {

    const target = `=${ session_name }:`
    const stamp = String( Math.floor( now() / 1_000 ) )
    const set = ( ...args ) => run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, ...args ] )

    try {

        // -o refuses to overwrite: an already-set stamp keeps its age
        if( !finished ) {
            await set( `-o`, `-t`, target, IDLE_OPTION, stamp ).catch( () => {} )
            return false
        }

        await set( `-t`, target, IDLE_OPTION, stamp )
        await set( `-t`, target, UNREAD_OPTION, stamp )
        return true

    } catch ( error ) {
        log.debug( `Could not mark ${ session_name } idle: ${ error.message }` )
        return false
    }

}

/**
 * Clear the unread stamp: input that bypasses tmux's key handling (web bridge
 * messages arrive as paste buffers) and so never moves `session_activity`.
 * Cosmetic: failures are only logged.
 * @param {string} session_name - Babysit tmux session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Command runner seam
 * @returns {Promise<boolean>} Whether the stamp was cleared
 */
export const mark_read = async ( session_name, { run_command = run } = {} ) => {

    try {
        await run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-u`, `-t`, `=${ session_name }:`, UNREAD_OPTION ] )
        return true
    } catch ( error ) {
        log.debug( `Could not mark ${ session_name } read: ${ error.message }` )
        return false
    }

}

/**
 * Move a session to the idle list by hand: stamp `@babysit_shelved_since` and
 * clear unread (it was dealt with). `list_sessions` reports the stamp; it only
 * holds while the agent idles, since the next finished turn stamps a newer
 * idle-since. Cosmetic: failures are only logged.
 * @param {string} session_name - Babysit tmux session name
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Command runner seam
 * @param {Function} [options.now=Date.now] - Clock seam
 * @returns {Promise<boolean>} Whether the session was shelved
 */
export const shelve_session = async ( session_name, { run_command = run, now = Date.now } = {} ) => {

    const target = `=${ session_name }:`
    const set = ( ...args ) => run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, ...args ] )

    try {
        await set( `-t`, target, SHELVED_OPTION, String( Math.floor( now() / 1_000 ) ) )
        await set( `-u`, `-t`, target, UNREAD_OPTION )
        return true
    } catch ( error ) {
        log.debug( `Could not shelve ${ session_name }: ${ error.message }` )
        return false
    }

}

/**
 * Unread: a turn ended and no human input reached tmux since. Keys and mouse
 * (scroll) bump `session_activity`; agent output and send-keys do not. Attach
 * also bumps it, to the attach second, so activity must beat `session_last_attached`
 * too: merely looking keeps it unread. Epoch seconds; same-second input stays unread.
 * @param {Object} stamps - Epoch-second strings from tmux
 * @returns {boolean}
 */
const is_unread = ( { unread_since, activity, last_attached } ) => {
    const since = Number( unread_since ) || 0
    if( !since ) return false
    return ( Number( activity ) || 0 ) <= Math.max( since, Number( last_attached ) || 0 )
}

/**
 * List all babysit tmux sessions
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - Surface inspection failures except an absent tmux server
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<Array<{ name: string, attached: boolean, created: string, agent_status: string, unread: boolean, idle_since: number|null, next_turn: number|null, last_opened: number|null, shelved_since: number|null, pane_title: string|null }>>}
 */
export const list_sessions = async ( { strict = false, run_command = run } = {} ) => {

    try {
        const output = await run_command( `tmux`, [
            `-L`, TMUX_SOCKET,
            `list-sessions`, `-F`,
            // Tmux 3.3a sanitizes literal tabs in formats into underscores.
            // Colons survive formatting and cannot occur in session names; the
            // pane title goes last because agents put colons in theirs.
            `#{session_name}:#{?session_attached,attached,detached}:#{session_created}:#{${ AGENT_STATUS_OPTION }}:#{session_last_attached}:#{session_activity}:#{${ UNREAD_OPTION }}:#{${ IDLE_OPTION }}:#{${ NEXT_TURN_OPTION }}:#{${ SHELVED_OPTION }}:#{pane_title}`,
        ] )

        return output.split( `\n` )
            .filter( line => line.startsWith( `babysit_` ) )
            .map( line => {
                const [ name, tmux_status, created, stored_agent_status, last_attached, activity, unread_since, idle_stamp, next_stamp, shelved_stamp, ...title_parts ] = line.split( `:` )
                const agent_status = [ `idle`, `waiting` ].includes( stored_agent_status ) ? stored_agent_status : `running`
                const attached = tmux_status === `attached`
                const unread = is_unread( { unread_since, activity, last_attached } )
                const idle_since = Number( idle_stamp ) > 0 ? Number( idle_stamp ) : null
                // Only a number is a countdown; `running`/`waiting` mean none is ticking
                const next_turn = Number( next_stamp ) > 0 ? Number( next_stamp ) : null
                // Only a human attach counts: a session nobody opened (loops, restarts) has no rank
                const last_opened = Number( last_attached ) > 0 ? Number( last_attached ) : null
                return { name, attached, created, agent_status, unread, idle_since, next_turn, last_opened, shelved_since: Number( shelved_stamp ) > 0 ? Number( shelved_stamp ) : null, pane_title: title_parts.join( `:` ) || null }
            } )

    } catch ( error ) {
        const no_server = /no server running|no sessions|error connecting to .*\(No such file or directory\)/i.test( error.message )
        if( strict && !no_server ) throw error
        return []
    }

}
