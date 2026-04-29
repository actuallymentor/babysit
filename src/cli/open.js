import { log } from '../utils/log.js'
import { has_session, list_sessions, attach_session } from '../tmux/session.js'
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
 * Attach to a tmux session. Delegates to the shared `attach_session` helper
 * which JSON.stringifies the session name for shell safety — directly
 * interpolating it would let metacharacters in unusual session names
 * break out of the tmux argument.
 * @param {string} session_name - Tmux session name
 */
const attach = ( session_name ) => {

    log.info( `Attaching to session: ${ session_name }` )
    attach_session( session_name )

}
