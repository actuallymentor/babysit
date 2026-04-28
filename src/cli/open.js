import { execSync } from 'child_process'
import { log } from '../utils/log.js'
import { has_session, list_sessions } from '../tmux/session.js'
import { TMUX_SOCKET } from '../utils/paths.js'
import { list_stored_sessions } from '../sessions/store.js'

/**
 * Attach to an active babysit tmux session
 * @param {Object} cmd - Parsed command { session_id }
 */
export const cmd_open = async ( cmd ) => {

    const { session_id } = cmd

    if( !session_id ) {
        log.error( `Usage: babysit open <session_id>` )
        process.exit( 1 )
    }

    // Try direct tmux session name match
    if( await has_session( session_id ) ) {
        attach( session_id )
        return
    }

    // Try looking up by babysit_id or agent_session_id in stored sessions
    const stored = list_stored_sessions()
    const match = stored.find( s =>
        s.babysit_id === session_id ||
        s.agent_session_id === session_id ||
        s.tmux_session?.includes( session_id )
    )

    if( match && await has_session( match.tmux_session ) ) {
        attach( match.tmux_session )
        return
    }

    // Fuzzy match against active sessions
    const active = await list_sessions()
    const fuzzy = active.find( s => s.name.includes( session_id ) )

    if( fuzzy ) {
        attach( fuzzy.name )
        return
    }

    log.error( `No active session found for: ${ session_id }` )
    log.error( `Run \`babysit list\` to see active sessions.` )
    process.exit( 1 )

}

/**
 * Exec into a tmux session (replaces current process)
 * @param {string} session_name - Tmux session name
 */
const attach = ( session_name ) => {

    log.info( `Attaching to session: ${ session_name }` )
    execSync( `tmux -L ${ TMUX_SOCKET } attach -t "${ session_name }"`, { stdio: `inherit` } )

}
