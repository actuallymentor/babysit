import { log } from '../utils/log.js'
import { load_session } from '../sessions/store.js'
import { has_session } from '../tmux/session.js'
import { cmd_open } from './open.js'
import { cmd_start } from './start.js'

/**
 * Resume a previous babysit session
 * If the tmux session is still alive, attach to it.
 * If it's exited, start a new session with the agent's resume flag.
 * @param {Object} cmd - Parsed command { session_id, flags }
 */
export const cmd_resume = async ( cmd ) => {

    const { session_id, flags } = cmd

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

        // Session is dead — restart with resume flag
        log.info( `Resuming ${ session.agent } session: ${ session_id }` )

        await cmd_start( {
            verb: `resume`,
            agent: session.agent,
            session_id: session.agent_session_id || session_id,
            flags: { ...flags, ...rebuild_flags( session.modifiers ) },
            passthrough: [],
        } )
        return

    }

    // No stored session — try to resume by guessing the agent from the ID format
    log.warn( `No stored session found for ${ session_id }, trying claude...` )
    await cmd_start( {
        verb: `resume`,
        agent: `claude`,
        session_id,
        flags,
        passthrough: [],
    } )

}

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
} )
