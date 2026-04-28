import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'

/**
 * List all active babysit sessions
 */
export const cmd_list = async () => {

    const tmux_sessions = await list_sessions()
    const stored_sessions = list_stored_sessions()

    if( tmux_sessions.length === 0 ) {
        console.log( `No active babysit sessions.` )
        return
    }

    console.log( `\nActive babysit sessions:\n` )
    console.log( `  ${ pad( `SESSION`, 50 ) }  ${ pad( `AGENT`, 10 ) }  ${ pad( `STATUS`, 10 ) }  ID` )
    console.log( `  ${ `-`.repeat( 90 ) }` )

    for( const tmux of tmux_sessions ) {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( s => s.tmux_session === tmux.name )
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || `-`
        const status = tmux.attached ? `attached` : `detached`

        console.log( `  ${ pad( tmux.name, 50 ) }  ${ pad( agent, 10 ) }  ${ pad( status, 10 ) }  ${ session_id }` )

    }

    console.log( `` )

}

/**
 * Pad a string to a fixed width
 * @param {string} str - Input string
 * @param {number} width - Target width
 * @returns {string}
 */
const pad = ( str, width ) => String( str ).padEnd( width )
