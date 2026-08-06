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
 * Format rows with widths derived from the visible table values.
 * @param {string[]} headers - Column labels
 * @param {Array<Array<string|number>>} rows - Values to display
 * @returns {{ header: string, divider: string, rows: string[] }}
 */
const format_table = ( headers, rows ) => {

    const column_widths = headers.map( ( header, index ) => Math.max(
        String( header ).length,
        ...rows.map( row => String( row[index] ).length )
    ) )

    const format_row = row => row
        .map( ( value, index ) => pad( value, column_widths[index] ) )
        .join( `  ` )
        .trimEnd()

    const table_width = column_widths.reduce( ( total, width ) => total + width, 0 )
        + ( column_widths.length - 1 ) * 2

    return {
        header: format_row( headers ),
        divider: `-`.repeat( table_width ),
        rows: rows.map( format_row ),
    }

}

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

    const headers = [
        ... numbered ? [ `#` ] : [] ,
        `NAME`,
        `STATUS`,
        `AGENT`,
        `ID`,
        `SESSION`,
    ]

    const rows = tmux_sessions.map( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( session => session.tmux_session === tmux.name )
        const name = stored?.name || `-`
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || `-`
        const status = tmux.attached ? `attached` : `detached`

        return [
            ... numbered ? [ index + 1 ] : [] ,
            name,
            status,
            agent,
            session_id,
            tmux.name,
        ]

    } )

    const table = format_table( headers, rows )

    console.log( `\n${ title }\n` )
    console.log( `  ${ table.header }` )
    console.log( `  ${ table.divider }` )
    table.rows.forEach( row => console.log( `  ${ row }` ) )

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
