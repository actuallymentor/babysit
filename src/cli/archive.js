import { log } from '../utils/log.js'
import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions, update_session } from '../sessions/store.js'
import { exited_session_message, order_active_sessions, stored_by_tmux } from './list.js'

/**
 * Resolve a list number, Babysit id, agent session id, or unique display name
 * to the stored record of an active session.
 * @param {string} selector - User input
 * @param {Array<{ name: string, exited?: boolean }>} active - Active tmux sessions in display order
 * @param {Object[]} stored - Stored Babysit metadata
 * @returns {Object} Stored session
 */
export const select_active_session = ( selector, active, stored ) => {

    const by_tmux = stored_by_tmux( stored )
    const stored_for = tmux => by_tmux.get( tmux.name )

    if( /^\d+$/.test( selector ) ) {
        const tmux = active[ Number( selector ) - 1 ]
        if( !tmux ) throw new Error( `No active session numbered ${ selector }. Run babysit list to see active sessions.` )
        const session = stored_for( tmux )
        if( !session ) throw new Error( `No stored session found for active session numbered ${ selector } (${ tmux.name }).` )
        // An exited fork parent keeps its number but is not running
        if( tmux.exited ) throw new Error( exited_session_message( selector, session, tmux ) )
        return session
    }

    const live = active.filter( tmux => !tmux.exited ).map( stored_for ).filter( Boolean )
    const by_id = live.find( session => session.babysit_id === selector || session.agent_session_id === selector )
    if( by_id ) return by_id

    const by_name = live.filter( session => session.name === selector )
    if( by_name.length > 1 ) throw new Error( `Several active sessions are named "${ selector }"; use a list number or id.` )
    if( by_name.length === 1 ) return by_name[0]

    throw new Error( `No active session matches ${ selector }` )

}

/**
 * Archive active sessions: they stay running, but `babysit list` dims them and
 * sinks them to the bottom of their workspace until `babysit open` brings them
 * back. Archiving renumbers the list, so every selector resolves against one
 * snapshot before the first write.
 * @param {Object} cmd - Parsed command { session_id, session_ids }
 * @param {Object} [deps]
 */
export const cmd_archive = async ( cmd, {
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    update_session_fn = update_session,
    print = message => log.info( message ),
} = {} ) => {

    const stored = list_stored_sessions_fn()
    const active = order_active_sessions( await list_sessions_fn(), stored )
    const selected = ( cmd.session_ids || [ cmd.session_id ] ).map( selector => select_active_session( selector, active, stored ) )
    const sessions = selected.filter( ( session, index ) => selected.findIndex( other => other.babysit_id === session.babysit_id ) === index )

    for( const session of sessions ) {

        if( session.archived_at ) {
            print( `${ session.name || session.babysit_id } is already archived; babysit open brings it back.` )
            continue
        }

        update_session_fn( session.babysit_id, { archived_at: new Date().toISOString() } )
        print( `Archived ${ session.name || session.babysit_id }; babysit open brings it back.` )

    }

}
