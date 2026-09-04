import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'
import { start_pipe_pane } from './capture.js'

const AGENT_STATUS_OPTION = `@babysit_agent_status`

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
 * @returns {Promise<{pipe_started: boolean}>}
 */
export const create_session = async ( session_name, command, {
    log_path = null,
    startup_log_path = null,
    status_label = null,
    run_command = run,
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

    if( status_label ) {
        try {
            await Promise.all( [
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `@babysit_status_label`, status_label ] ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status`, `on` ] ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-position`, `bottom` ] ),
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-left`, `#[bold]#{@babysit_status_label}#[default] ` ] ),
                // Tmux measures this limit in terminal columns. Two columns
                // per UTF-16 code unit safely covers CJK and emoji labels.
                run_command( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `status-left-length`, String( status_label.length * 2 + 1 ) ] ),
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
 * @returns {Promise<boolean>}
 */
export const has_session = async ( session_name ) => {

    try {
        await run( `tmux`, [ `-L`, TMUX_SOCKET, `has-session`, `-t`, session_name ] )
        return true
    } catch {
        return false
    }

}

/**
 * Kill a tmux session
 * @param {string} session_name - The session name
 * @returns {Promise<void>}
 */
export const kill_session = async ( session_name ) => {

    try {
        await run( `tmux`, [ `-L`, TMUX_SOCKET, `kill-session`, `-t`, session_name ] )
        log.info( `Killed tmux session: ${ session_name }` )
    } catch {
        log.debug( `Session already gone: ${ session_name }` )
    }

}

/**
 * Attach to an existing tmux session.
 * @param {string} session_name - The session name
 * @param {Object} [options]
 * @param {Function} [options.exec_command] - Injectable synchronous command runner
 * @returns {true} Indicates that the foreground tmux client has exited
 */
export const attach_session = ( session_name, { exec_command = execSync } = {} ) => {

    try {
        exec_command( `tmux -L ${ TMUX_SOCKET } attach -t ${ JSON.stringify( session_name ) }`, {
            stdio: `inherit`,
        } )
    } catch ( error ) {
        // Tmux can exit non-zero after a normal detach. Callers re-check the
        // target session to distinguish that case from a natural session end.
        log.debug( `tmux attach exited: ${ error.message }` )
    }

    return true

}

/**
 * Publish coding-agent activity on its tmux session for `babysit list`.
 * @param {string} session_name - Babysit tmux session name
 * @param {'idle'|'running'} status - Current coding-agent activity
 * @returns {Promise<boolean>} Whether tmux accepted the update
 */
export const set_agent_status = async ( session_name, status ) => {

    try {
        await run( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, AGENT_STATUS_OPTION, status ] )
        return true
    } catch ( error ) {
        log.debug( `Could not publish ${ session_name } agent status: ${ error.message }` )
        return false
    }

}

/**
 * List all babysit tmux sessions
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - Surface inspection failures except an absent tmux server
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<Array<{ name: string, attached: boolean, created: string, agent_status: string }>>}
 */
export const list_sessions = async ( { strict = false, run_command = run } = {} ) => {

    try {
        const output = await run_command( `tmux`, [
            `-L`, TMUX_SOCKET,
            `list-sessions`, `-F`,
            `#{session_name}\t#{?session_attached,attached,detached}\t#{session_created}\t#{${ AGENT_STATUS_OPTION }}`,
        ] )

        return output.split( `\n` )
            .filter( line => line.startsWith( `babysit_` ) )
            .map( line => {
                const [ name, tmux_status, created, stored_agent_status ] = line.split( `\t` )
                const agent_status = stored_agent_status === `idle` ? `idle` : `running`
                return { name, attached: tmux_status === `attached`, created, agent_status }
            } )

    } catch ( error ) {
        const no_server = /no server running|no sessions|error connecting to .*\(No such file or directory\)/i.test( error.message )
        if( strict && !no_server ) throw error
        return []
    }

}
