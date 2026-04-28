import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { TMUX_SOCKET } from '../utils/paths.js'

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
 * Create a new detached tmux session with babysit defaults
 * @param {string} session_name - The session name
 * @param {string} command - The command to run inside the session
 * @param {Object} [env={}] - Extra environment variables
 * @returns {Promise<void>}
 */
export const create_session = async ( session_name, command, env = {} ) => {

    // Build the environment string for the shell command
    const env_prefix = Object.entries( env )
        .map( ( [ k, v ] ) => `${ k }=${ JSON.stringify( v ) }` )
        .join( ` ` )

    const full_command = env_prefix ? `env ${ env_prefix } ${ command }` : command

    await run( `tmux`, [
        `-L`, TMUX_SOCKET,
        `new-session`, `-d`,
        `-s`, session_name,
        `-x`, `220`, `-y`, `50`,
        `sh`, `-c`, full_command,
    ] )

    // Configure session defaults
    await Promise.all( [
        run( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `-g`, `history-limit`, `10000` ] ),
        run( `tmux`, [ `-L`, TMUX_SOCKET, `set-option`, `-t`, session_name, `-g`, `mouse`, `on` ] ),
    ] )

    log.info( `Created tmux session: ${ session_name }` )

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
 * Attach to an existing tmux session (replaces current process)
 * @param {string} session_name - The session name
 */
export const attach_session = ( session_name ) => {

    execSync( `tmux -L ${ TMUX_SOCKET } attach -t ${ JSON.stringify( session_name ) }`, {
        stdio: `inherit`,
    } )

}

/**
 * List all babysit tmux sessions
 * @returns {Promise<Array<{ name: string, attached: boolean, created: string }>>}
 */
export const list_sessions = async () => {

    try {
        const output = await run( `tmux`, [
            `-L`, TMUX_SOCKET,
            `list-sessions`, `-F`,
            `#{session_name}\t#{?session_attached,attached,detached}\t#{session_created}`,
        ] )

        return output.split( `\n` )
            .filter( line => line.startsWith( `babysit_` ) )
            .map( line => {
                const [ name, status, created ] = line.split( `\t` )
                return { name, attached: status === `attached`, created }
            } )

    } catch {
        return []
    }

}
