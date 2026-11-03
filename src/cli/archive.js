import { createInterface } from 'node:readline/promises'

import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions, update_session } from '../sessions/store.js'
import { relative_time } from '../docker/assets/usage/format.mjs'
import { exited_session_message, order_active_sessions, session_dot, stored_by_tmux } from './list.js'

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
 * Ask a default-yes question on the terminal.
 * @param {string} question - Prompt ending in [Y/n]
 * @returns {Promise<boolean>}
 */
const ask_default_yes = async question => {
    const rl = createInterface( { input: process.stdin, output: process.stdout } )
    try {
        return /^(?:y(?:es)?)?$/i.test( ( await rl.question( question ) ).trim() )
    } finally {
        rl.close()
    }
}

/**
 * Unarchived sessions showing the grey dot: idle over 24 hours with nothing
 * unread. Reads the activity monitors publish (no pane sampling), so a `stuck`
 * flag or a frozen container keeps a session out.
 * @param {Object[]} active - Active tmux sessions in display order
 * @param {Object[]} stored - Stored Babysit metadata
 * @param {number} now - Epoch ms
 * @returns {Array<{ number: number, session: Object, tmux: Object }>}
 */
export const stale_sessions = ( active, stored, now ) => {

    const by_tmux = stored_by_tmux( stored )
    return active
        .map( ( tmux, index ) => ( { number: index + 1, tmux, session: by_tmux.get( tmux.name ) } ) )
        .filter( ( { tmux, session } ) => session && !tmux.exited && !session.archived_at && !session.stuck_at && !session.frozen_at )
        .filter( ( { tmux } ) => session_dot( tmux, tmux.agent_status, now ) === `stale` )

}

/**
 * Archive active sessions: they stay running, but `babysit list` dims them and
 * sinks them to the bottom of their workspace until `babysit open` brings them
 * back. Archiving renumbers the list, so every selector resolves against one
 * snapshot before the first write.
 * Without selectors it offers every grey-dot session (idle over 24h) behind
 * one `Archive N sessions? [Y/n]`; `--yes` skips the question, and scripts
 * without a terminal must pass it.
 * @param {Object} cmd - Parsed command { session_id, session_ids, flags }
 * @param {Object} [deps]
 */
export const cmd_archive = async ( cmd, {
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    update_session_fn = update_session,
    ask_fn = ask_default_yes,
    interactive = Boolean( process.stdin.isTTY ),
    now = Date.now(),
    print = message => console.log( message ),
} = {} ) => {

    const stored = list_stored_sessions_fn()
    const active = order_active_sessions( await list_sessions_fn(), stored )
    const selectors = cmd.session_ids?.length ? cmd.session_ids : [ cmd.session_id ].filter( Boolean )

    if( !selectors.length ) {

        const stale = stale_sessions( active, stored, now )
        if( !stale.length ) return print( `No sessions idle over 24 hours.` )

        const label = session => session.name || session.babysit_id
        const width = Math.max( ...stale.map( ( { session } ) => label( session ).length ) )
        stale.forEach( ( { number, session, tmux } ) => {
            const idle_for = relative_time( now, tmux.idle_since * 1_000 )?.replace( /^in /, `` )
            print( `  ${ String( number ).padStart( 2 ) }  ${ label( session ).padEnd( width ) }  idle ${ idle_for }` )
        } )

        const count = `${ stale.length } session${ stale.length === 1 ? `` : `s` }`
        if( !cmd.flags?.yes && !interactive ) {
            process.exitCode = 1
            return print( `Not a terminal; pass --yes to archive ${ count }.` )
        }
        if( !cmd.flags?.yes && !await ask_fn( `Archive ${ count }? [Y/n] ` ) ) return

        stale.forEach( ( { session } ) => update_session_fn( session.babysit_id, { archived_at: new Date( now ).toISOString() } ) )
        return print( `Archived ${ count }; babysit open brings one back.` )

    }

    const selected = selectors.map( selector => select_active_session( selector, active, stored ) )
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
