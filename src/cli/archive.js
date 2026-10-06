import { log } from '../utils/log.js'
import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions, update_session } from '../sessions/store.js'
import { order_active_sessions } from './list.js'

/**
 * Resolve a list number, Babysit id, agent session id, or unique display name
 * to the stored record of an active session.
 * @param {string} selector - User input
 * @param {Array<{ name: string }>} active - Active tmux sessions in display order
 * @param {Object[]} stored - Stored Babysit metadata
 * @returns {Object} Stored session
 */
export const select_active_session = ( selector, active, stored ) => {

    const stored_for = tmux => stored.find( session => session.tmux_session === tmux.name )

    if( /^\d+$/.test( selector ) ) {
        const tmux = active[ Number( selector ) - 1 ]
        if( !tmux ) throw new Error( `No active session numbered ${ selector }. Run babysit list to see active sessions.` )
        const session = stored_for( tmux )
        if( !session ) throw new Error( `No stored session found for active session numbered ${ selector } (${ tmux.name }).` )
        return session
    }

    const live = active.map( stored_for ).filter( Boolean )
    const by_id = live.find( session => session.babysit_id === selector || session.agent_session_id === selector )
    if( by_id ) return by_id

    const by_name = live.filter( session => session.name === selector )
    if( by_name.length > 1 ) throw new Error( `Several active sessions are named "${ selector }"; use a list number or id.` )
    if( by_name.length === 1 ) return by_name[0]

    throw new Error( `No active session matches ${ selector }` )

}

/**
 * Archive an active session: it stays running, but `babysit list` dims it and
 * sinks it to the bottom of its workspace until `babysit open` brings it back.
 * @param {Object} cmd - Parsed command { session_id }
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
    const session = select_active_session( cmd.session_id, active, stored )

    if( session.archived_at ) {
        print( `${ session.name || session.babysit_id } is already archived; babysit open brings it back.` )
        return
    }

    update_session_fn( session.babysit_id, { archived_at: new Date().toISOString() } )
    print( `Archived ${ session.name || session.babysit_id }; babysit open brings it back.` )

}
