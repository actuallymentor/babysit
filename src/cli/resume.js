import { existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../utils/log.js'
import {
    list_stored_sessions,
    load_session,
    session_original_workspace,
    session_workspace,
    update_session,
} from '../sessions/store.js'
import { has_session } from '../tmux/session.js'
import { cmd_open } from './open.js'
import { cmd_start, spawn_monitor_daemon } from './start.js'
import { is_monitor_alive } from './monitor_process.js'

export { is_monitor_alive } from './monitor_process.js'

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

    const timestamp_ms = Date.parse( started_at )
    if( Number.isNaN( timestamp_ms ) ) return `unknown`

    return new Date( timestamp_ms ).toISOString().replace( `T`, ` ` ).slice( 0, 19 )

}

/**
 * Identify the agent-less, selector-less resume command that lists history.
 * Explicit-agent resumes still launch an agent and need normal dependencies.
 * @param {Object} cmd - Parsed command descriptor
 * @returns {boolean} Whether the command only reads the local session registry
 */
export const is_resume_listing = ( cmd ) => cmd.verb === `resume` && !cmd.agent && !cmd.session_id

/**
 * Prefer sessions launched from the current workspace. When the workspace has
 * no history, retain the full registry so bare resume remains useful anywhere.
 * @param {Object[]} sessions - Stored session records, newest first
 * @param {string} cwd - Current working directory
 * @returns {Object[]} Workspace sessions when present, otherwise every session
 */
export const select_resumable_sessions = ( sessions, cwd ) => {

    const resolved_cwd = resolve( cwd )
    const workspace_sessions = sessions.filter( session => [
        session_original_workspace( session ),
        session_workspace( session ),
    ].filter( Boolean ).some( path => resolve( path ) === resolved_cwd ) )

    return workspace_sessions.length > 0 ? workspace_sessions : sessions

}


/**
 * Print every Babysit-managed session that can be reopened. Babysit IDs stay
 * visible as the canonical resume handle because they restore the agent,
 * workspace, and launch modes; native IDs are shown separately for clarity.
 * @param {Object[]} sessions - Stored Babysit session metadata, newest first
 * @param {Object} [options]
 * @param {string|null} [options.workspace=null] - Workspace scope when rows are filtered
 */
export const print_resumable_sessions_table = ( sessions, { workspace = null } = {} ) => {

    if( sessions.length === 0 ) {
        console.log( `No resumable babysit sessions.` )
        return
    }

    const heading = workspace
        ? `Resumable babysit sessions for ${ workspace }:`
        : `Resumable babysit sessions:`

    console.log( `\n${ heading }\n` )
    console.log( `  ${ pad( `BABYSIT ID`, 24 ) }  ${ pad( `NAME`, 24 ) }  ${ pad( `AGENT`, 10 ) }  ${ pad( `AGENT SESSION ID`, 38 ) }  ${ pad( `STARTED`, 19 ) }  WORKSPACE` )
    console.log( `  ${ `-`.repeat( 147 ) }` )

    sessions.forEach( session => {

        const name = session.name || `-`
        const agent_session_id = session.agent_session_id || `-`
        const started_at = format_started_at( session.started_at )

        const workspace = session_workspace( session )
        console.log( `  ${ pad( session.babysit_id, 24 ) }  ${ pad( name, 24 ) }  ${ pad( session.agent, 10 ) }  ${ pad( agent_session_id, 38 ) }  ${ pad( started_at, 19 ) }  ${ workspace || `-` }` )

    } )

    if( workspace ) console.log( `\nShow every workspace with: babysit resume --all` )

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
    clone: modifiers.includes( `clone` ),
    loop: modifiers.includes( `loop` ),
    ignore_host_agents_md: modifiers.includes( `ignore-host-agents-md` ),
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
 * @param {Function} [options.load_session_fn=load_session] - Session metadata loader
 * @param {Function} [options.list_stored_sessions_fn=list_stored_sessions] - Session history loader
 * @param {Function} [options.print_sessions=print_resumable_sessions_table] - Session history renderer
 * @param {Function} [options.get_cwd=process.cwd] - Current workspace loader
 * @param {Function} [options.has_session_fn=has_session] - Active tmux session check
 * @param {Function} [options.open_session=cmd_open] - Active session attach delegate
 * @param {Function} [options.monitor_is_alive=is_monitor_alive] - Monitor PID probe
 * @param {Function} [options.spawn_monitor=spawn_monitor_daemon] - Detached monitor restarter
 * @param {Function} [options.update_session_fn=update_session] - Session metadata updater
 */
export const cmd_resume = async ( cmd, {
    start = cmd_start,
    load_session_fn = load_session,
    list_stored_sessions_fn = list_stored_sessions,
    print_sessions = print_resumable_sessions_table,
    get_cwd = process.cwd,
    has_session_fn = has_session,
    open_session = cmd_open,
    monitor_is_alive = is_monitor_alive,
    spawn_monitor = spawn_monitor_daemon,
    update_session_fn = update_session,
} = {} ) => {

    const { session_id, flags = {}, passthrough = [] } = cmd

    if( !session_id ) {
        const stored_sessions = list_stored_sessions_fn()
        const sessions = stored_sessions.some( session => session.clone_pruned_at )
            ? stored_sessions.filter( session => !session.clone_pruned_at )
            : stored_sessions
        const current_cwd = flags.all ? null : get_cwd()
        const visible_sessions = flags.all
            ? sessions
            : select_resumable_sessions( sessions, current_cwd )
        const workspace = visible_sessions.length < sessions.length
            ? resolve( current_cwd )
            : null

        print_sessions( visible_sessions, { workspace } )
        return
    }

    // Look up session metadata
    const session = load_session_fn( session_id )

    if( session ) {

        if( session.clone_pruned_at ) {
            throw new Error( `Clone workspace was pruned at ${ session.clone_pruned_at }: ${ session.clone_path }` )
        }

        const was_clone = Boolean(
            session.clone_path
            || session.modifiers?.includes( `clone` )
        )
        if( flags.clone && !was_clone ) {
            throw new Error( `--clone cannot be added while resuming a non-clone session; start a new clone session instead.` )
        }

        const merged_flags = merge_resume_flags( session.modifiers, flags, session )

        // A live container cannot gain a stricter mount boundary after it has
        // started. Refuse the attach instead of silently ignoring an isolation
        // upgrade that the user explicitly requested.
        if( await has_session_fn( session.tmux_session ) ) {
            const was_isolated = session.modifiers?.includes( `ignore-host-agents-md` )
            if( merged_flags.ignore_host_agents_md && !was_isolated ) {
                throw new Error(
                    `--ignore-host-agents-md cannot be applied to an already-running session; exit it first, then resume it.`
                )
            }

            if( was_clone && !monitor_is_alive( session.monitor_pid, session.monitor_token ) ) {
                log.warn( `Session monitor is not running; restarting it before attach.` )
                const monitor_pid = await spawn_monitor(
                    session.babysit_id,
                    session.monitor_token
                )
                update_session_fn( session.babysit_id, { monitor_pid } )
            }

            log.info( `Session still active, attaching...` )
            await open_session( { session_id: session.tmux_session } )
            return
        }

        // Session is dead — restart with resume flag.
        // Start from the stored modifiers, then layer on any explicit user flags
        // so the user can add --loop or --yolo when resuming an older session.
        log.info( `Resuming ${ session.agent } session: ${ session_id }` )

        // Clone sessions keep config, loop actions, and native agent state tied
        // to their durable copy. Legacy records continue to use pwd.
        const workspace = session_workspace( session )
        if( workspace && existsSync( workspace ) ) {
            log.debug( `Restoring cwd: ${ workspace }` )
            process.chdir( workspace )
        } else if( workspace ) {
            if( was_clone ) throw new Error( `Session workspace no longer exists: ${ workspace }` )
            log.warn( `Original session pwd no longer exists: ${ workspace }` )
        }

        const resume_target = resolve_resume_target( session )

        await start( {
            verb: `resume`,
            agent: session.agent,
            metadata_resolved: true,
            stored_session: session,
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
