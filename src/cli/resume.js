import { existsSync } from 'fs'
import { log } from '../utils/log.js'
import { list_stored_sessions, load_session } from '../sessions/store.js'
import { has_session } from '../tmux/session.js'
import { cmd_open } from './open.js'
import { cmd_start } from './start.js'

/**
 * Pad a value to a fixed width for the resume-history table.
 * @param {string|number} value - Display value
 * @param {number} width - Target width
 * @returns {string} Padded display value
 */
const pad = ( value, width ) => String( value ).padEnd( width )

/**
 * Render a compact, consistently sortable session timestamp.
 * @param {string} [started_at] - ISO session start timestamp
 * @returns {string} Human-readable timestamp, or a fallback for legacy records
 */
const format_started_at = ( started_at ) => {

    const timestamp = new Date( started_at )
    if( Number.isNaN( timestamp.getTime() ) ) return `unknown`

    return timestamp.toISOString().replace( `T`, ` ` ).slice( 0, 19 )

}

/**
 * Print every Babysit-managed session that can be reopened. Babysit IDs stay
 * visible as the canonical resume handle because they restore the agent,
 * workspace, and launch modes; native IDs are shown separately for clarity.
 * @param {Object[]} sessions - Stored Babysit session metadata, newest first
 */
export const print_resumable_sessions_table = ( sessions ) => {

    if( sessions.length === 0 ) {
        console.log( `No resumable babysit sessions.` )
        return
    }

    console.log( `\nResumable babysit sessions:\n` )
    console.log( `  ${ pad( `BABYSIT ID`, 24 ) }  ${ pad( `NAME`, 24 ) }  ${ pad( `AGENT`, 10 ) }  ${ pad( `AGENT SESSION ID`, 38 ) }  ${ pad( `STARTED`, 19 ) }  WORKSPACE` )
    console.log( `  ${ `-`.repeat( 147 ) }` )

    sessions.forEach( session => {

        const name = session.name || `-`
        const agent_session_id = session.agent_session_id || `-`
        const started_at = format_started_at( session.started_at )

        console.log( `  ${ pad( session.babysit_id, 24 ) }  ${ pad( name, 24 ) }  ${ pad( session.agent, 10 ) }  ${ pad( agent_session_id, 38 ) }  ${ pad( started_at, 19 ) }  ${ session.pwd || `-` }` )

    } )

    console.log( `\nResume one with: babysit resume <babysit_id>\n` )

}

/**
 * Rebuild flags from stored session modifiers
 * @param {string[]} modifiers - e.g. ['yolo', 'loop']
 * @returns {Object} Flag object
 */
const rebuild_flags = ( modifiers = [], session = {} ) => ( {
    yolo: modifiers.includes( `yolo` ),
    sandbox: modifiers.includes( `sandbox` ),
    mudbox: modifiers.includes( `mudbox` ),
    docker: modifiers.includes( `docker` ),
    loop: modifiers.includes( `loop` ),
    name: session.name || false,
    log: false,
    ports: Array.isArray( session.ports ) ? session.ports : [],
} )

const is_explicit_user_flag = ( [ key, value ] ) => {

    if( key === `log` ) return value !== false
    if( key === `ports` ) return Array.isArray( value ) && value.length > 0

    return Boolean( value )

}

/**
 * Rebuild a dead session's mode flags and layer explicit resume-time flags on top.
 * `--log` uses an empty string as a meaningful "default path" sentinel, so it
 * cannot be filtered with the boolean mode flags.
 * @param {string[]} [modifiers] - Stored session modifiers
 * @param {Object} [flags] - Parsed resume-time flags
 * @param {Object} [session] - Stored session metadata
 * @returns {Object} Flags for cmd_start
 */
export const merge_resume_flags = ( modifiers = [], flags = {}, session = {} ) => {

    const explicit_user_flags = Object.fromEntries(
        Object.entries( flags ).filter( is_explicit_user_flag )
    )

    return { ...rebuild_flags( modifiers, session ), ...explicit_user_flags }

}

/**
 * Resolve how a stored Babysit session should be resumed.
 * If the monitor captured the agent-native session id, use it directly. If it
 * did not, the Babysit id is only useful for looking up metadata; passing that
 * timestamp-shaped id to the agent would fail, so use the agent's latest/
 * continue mode from the restored workspace instead.
 * @param {Object} session - Stored session metadata
 * @returns {Object} Resume args for cmd_start
 */
export const resolve_resume_target = ( session ) => {

    if( session.agent_session_id ) {
        return {
            session_id: session.agent_session_id,
            resume_latest: false,
        }
    }

    return {
        session_id: null,
        resume_latest: true,
    }

}

/**
 * List previous sessions when no id is provided, or resume a selected session.
 * If the tmux session is still alive, attach to it.
 * If it's exited, start a new session with the agent's resume flag.
 * @param {Object} cmd - Parsed command { session_id, flags }
 * @param {Object} [options]
 * @param {Function} [options.start=cmd_start] - Start command delegate, injectable for tests
 * @param {Function} [options.list_stored_sessions_fn=list_stored_sessions] - Session history loader
 * @param {Function} [options.print_sessions=print_resumable_sessions_table] - Session history renderer
 */
export const cmd_resume = async ( cmd, {
    start = cmd_start,
    list_stored_sessions_fn = list_stored_sessions,
    print_sessions = print_resumable_sessions_table,
} = {} ) => {

    const { session_id, flags = {}, passthrough = [] } = cmd

    if( !session_id ) {
        print_sessions( list_stored_sessions_fn() )
        return
    }

    // Look up session metadata
    const session = load_session( session_id )

    if( session ) {

        // If tmux session is still alive, just attach
        if( await has_session( session.tmux_session ) ) {
            log.info( `Session still active, attaching...` )
            await cmd_open( { session_id: session.tmux_session } )
            return
        }

        // Session is dead — restart with resume flag.
        // Start from the stored modifiers, then layer on any explicit user flags
        // so the user can add --loop or --yolo when resuming an older session.
        log.info( `Resuming ${ session.agent } session: ${ session_id }` )

        const merged_flags = merge_resume_flags( session.modifiers, flags, session )

        // chdir to the session's original working directory so cmd_start picks up
        // the right babysit.yaml and resolves cwd-relative paths (./IDLE.md,
        // ./LOOP.md) the same way the original session did. Otherwise running
        // `babysit resume <id>` from /home loads the wrong config.
        if( session.pwd && existsSync( session.pwd ) ) {
            log.debug( `Restoring cwd: ${ session.pwd }` )
            process.chdir( session.pwd )
        } else if( session.pwd ) {
            log.warn( `Original session pwd no longer exists: ${ session.pwd }` )
        }

        const resume_target = resolve_resume_target( session )

        await start( {
            verb: `resume`,
            agent: session.agent,
            metadata_resolved: true,
            ...resume_target,
            flags: merged_flags,
            passthrough,
        } )
        return

    }

    // No stored session and no agent — we can't safely guess which CLI to launch.
    // Point the user at the explicit form so the agent name is unambiguous.
    log.error( `No stored session found for: ${ session_id }` )
    log.error( `Use the explicit form: babysit <agent> resume ${ session_id }` )
    log.error( `Run \`babysit list\` to see active sessions.` )
    process.exit( 1 )

}
