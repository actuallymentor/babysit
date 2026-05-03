import { existsSync } from 'fs'
import { log } from '../utils/log.js'
import { load_session } from '../sessions/store.js'
import { has_session } from '../tmux/session.js'
import { cmd_open } from './open.js'
import { cmd_start } from './start.js'

/**
 * Rebuild flags from stored session modifiers
 * @param {string[]} modifiers - e.g. ['yolo', 'loop']
 * @returns {Object} Flag object
 */
const rebuild_flags = ( modifiers = [] ) => ( {
    yolo: modifiers.includes( `yolo` ),
    sandbox: modifiers.includes( `sandbox` ),
    mudbox: modifiers.includes( `mudbox` ),
    loop: modifiers.includes( `loop` ),
    log: false,
} )

const is_explicit_user_flag = ( [ key, value ] ) => {

    if( key === `log` ) return value !== false

    return Boolean( value )

}

/**
 * Rebuild a dead session's mode flags and layer explicit resume-time flags on top.
 * `--log` uses an empty string as a meaningful "default path" sentinel, so it
 * cannot be filtered with the boolean mode flags.
 * @param {string[]} [modifiers] - Stored session modifiers
 * @param {Object} [flags] - Parsed resume-time flags
 * @returns {Object} Flags for cmd_start
 */
export const merge_resume_flags = ( modifiers = [], flags = {} ) => {

    const explicit_user_flags = Object.fromEntries(
        Object.entries( flags ).filter( is_explicit_user_flag )
    )

    return { ...rebuild_flags( modifiers ), ...explicit_user_flags }

}

/**
 * Resume a previous babysit session
 * If the tmux session is still alive, attach to it.
 * If it's exited, start a new session with the agent's resume flag.
 * @param {Object} cmd - Parsed command { session_id, flags }
 */
export const cmd_resume = async ( cmd ) => {

    const { session_id, flags = {}, passthrough = [] } = cmd

    if( !session_id ) {
        log.error( `Usage: babysit resume <session_id>` )
        process.exit( 1 )
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

        const merged_flags = merge_resume_flags( session.modifiers, flags )

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

        await cmd_start( {
            verb: `resume`,
            agent: session.agent,
            session_id: session.agent_session_id || session_id,
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
