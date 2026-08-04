import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'

/**
 * Pad a string to a fixed width
 * @param {string} str - Input string
 * @param {number} width - Target width
 * @returns {string}
 */
const pad = ( str, width ) => String( str ).padEnd( width )

/**
 * Print active sessions in the same table shape used by `babysit list`.
 * @param {Array<{ name: string, attached: boolean }>} tmux_sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @param {Object} [options]
 * @param {string} [options.title] - Table title
 * @param {boolean} [options.numbered=false] - Show current-directory selectors
 */
export const print_active_sessions_table = ( tmux_sessions, stored_sessions, {
    title = `Active babysit sessions:`,
    numbered = false,
} = {} ) => {

    const number_header = numbered ? `${ pad( `#`, 3 ) }  ` : ``

    console.log( `\n${ title }\n` )
    console.log( `  ${ number_header }${ pad( `SESSION`, 50 ) }  ${ pad( `NAME`, 24 ) }  ${ pad( `AGENT`, 10 ) }  ${ pad( `STATUS`, 10 ) }  ID` )
    console.log( `  ${ `-`.repeat( numbered ? 122 : 117 ) }` )

    tmux_sessions.forEach( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( s => s.tmux_session === tmux.name )
        const number = numbered ? `${ pad( index + 1, 3 ) }  ` : ``
        const name = stored?.name || `-`
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || `-`
        const status = tmux.attached ? `attached` : `detached`

        console.log( `  ${ number }${ pad( tmux.name, 50 ) }  ${ pad( name, 24 ) }  ${ pad( agent, 10 ) }  ${ pad( status, 10 ) }  ${ session_id }` )

    } )

    console.log( `` )
    if( numbered ) console.log( `Open one with: babysit open <number>\n` )

}

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

    print_active_sessions_table( tmux_sessions, stored_sessions )

}
