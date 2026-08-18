import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'

const AGENT_STATUSES = new Set( [ `idle`, `running` ] )

/**
 * Pad a string to a fixed width
 * @param {string} str - Input string
 * @param {number} width - Target width
 * @returns {string}
 */
const pad = ( str, width ) => String( str ).padEnd( width )

/**
 * Keep only the deepest two levels of a session working directory.
 * @param {string} pwd - Full session working directory
 * @returns {string} Compact directory, or "-" when unavailable
 */
export const format_session_directory = ( pwd ) => {

    if( !pwd ) return `-`

    const levels = String( pwd ).split( /[\\/]+/ ).filter( Boolean )
    return levels.slice( -2 ).join( `/` ) || String( pwd )

}

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
 * @param {boolean} [options.numbered=false] - Show active-list selectors
 * @param {number[]} [options.numbers] - Global selectors for a filtered table
 * @param {boolean} [options.all=false] - Include diagnostic IDs and raw tmux names
 */
export const print_active_sessions_table = ( tmux_sessions, stored_sessions, {
    title = `Active babysit sessions:`,
    numbered = false,
    numbers = tmux_sessions.map( ( _, index ) => index + 1 ),
    all = false,
} = {} ) => {

    const headers = [
        ... numbered ? [ `#` ] : [] ,
        `NAME`,
        `STATUS`,
        `TMUX`,
        `AGENT`,
        `DIRECTORY`,
        ... all ? [ `ID`, `SESSION` ] : [],
    ]

    const rows = tmux_sessions.map( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( session => session.tmux_session === tmux.name )
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || tmux.name
        const name = stored?.name || session_id
        const status = AGENT_STATUSES.has( tmux.agent_status ) ? tmux.agent_status : `running`
        const tmux_status = tmux.attached ? `attached` : `detached`
        const directory = format_session_directory( stored?.pwd )

        return [
            ... numbered ? [ numbers[index] ] : [] ,
            name,
            status,
            tmux_status,
            agent,
            directory,
            ... all ? [ session_id, tmux.name ] : [],
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
 * @param {Object} [deps]
 * @param {Object} [deps.flags] - Parsed list display flags
 * @param {Function} [deps.list_sessions_fn] - Active tmux session loader
 * @param {Function} [deps.list_stored_sessions_fn] - Stored metadata loader
 */
export const cmd_list = async ( {
    flags = {},
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
} = {} ) => {

    const tmux_sessions = await list_sessions_fn()
    const stored_sessions = list_stored_sessions_fn()

    if( tmux_sessions.length === 0 ) {
        console.log( `No active babysit sessions.` )
        return
    }

    print_active_sessions_table( tmux_sessions, stored_sessions, {
        numbered: true,
        all: flags.all,
    } )

}
