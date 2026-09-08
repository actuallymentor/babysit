import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'
import { capture_pane } from '../tmux/capture.js'
import { agent_status } from '../babysit/activity.js'
import { strip_ansi } from '../babysit/matcher.js'
import { setTimeout as delay } from 'node:timers/promises'

const AGENT_STATUSES = new Set( [ `idle`, `running`, `unknown` ] )

/**
 * Observe current panes instead of trusting options left by an old or stopped
 * monitor. Sample sessions together so listing costs one polling interval.
 * @param {Object[]} sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored agent identities
 * @param {Object} [options] - Pane capture and wait seams
 * @returns {Promise<Object[]>} Sessions with freshly observed activity
 */
export const observe_session_activity = async ( sessions, stored_sessions, {
    capture = capture_pane,
    wait = delay,
} = {} ) => {

    const sample = async session => {
        try {
            return strip_ansi( await capture( `=${ session.name }:` ) )
        } catch {
            return null
        }
    }

    const before = await Promise.all( sessions.map( sample ) )
    await wait( 1_000 )
    const after = await Promise.all( sessions.map( sample ) )

    return sessions.map( ( session, index ) => {
        const agent = stored_sessions.find( stored => stored.tmux_session === session.name )?.agent
        const observed_status = before[index] === null || after[index] === null
            ? `unknown`
            : agent_status( after[index], agent, before[index] === after[index] ? 1 : 0 )

        return { ...session, agent_status: observed_status }
    } )

}

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
 * Format stored launch modifiers for the active-session table.
 * @param {string[]} modifiers - Session launch modifiers
 * @returns {string} Comma-separated flags, or "-" when none were recorded
 */
export const format_session_flags = ( modifiers ) =>
    Array.isArray( modifiers ) && modifiers.length ? modifiers.join( `,` ) : `-`

/**
 * Replace terminal controls and tmux style markers before storing display text.
 * @param {*} value - Value to make safe for display
 * @returns {string} Single-line display text
 */
const sanitize_status_value = value => {

    const single_line_value = Array.from( String( value ), character => {

        const code_point = character.codePointAt( 0 )
        const is_ascii_control = code_point < 32
        const is_extended_control = code_point >= 127 && code_point <= 159
        const is_control = is_ascii_control || is_extended_control
        return is_control ? `?` : character

    } ).join( `` )

    // User-option values are not recursively expanded as formats, but tmux
    // still parses style markers such as #[fg=red] when it draws status-left.
    return single_line_value.replaceAll( `#[`, `?[` )

}

/**
 * Build the compact identity shown in a Babysit tmux status bar.
 * @param {Object} session - Session identity
 * @param {string|null} [session.name] - Optional human-readable session name
 * @param {string} session.pwd - Original working directory
 * @param {string[]} [session.modifiers] - Active launch modifiers
 * @returns {string} Literal-safe status label
 */
export const format_session_status_label = ( { name = null, pwd, modifiers = [] } ) => {

    const flags = modifiers
        .filter( modifier => modifier && modifier !== `name` )
        .map( sanitize_status_value )

    return [
        name ? sanitize_status_value( name ) : null,
        sanitize_status_value( format_session_directory( pwd ) ),
        flags.length ? `[${ flags.join( `, ` ) }]` : null,
    ].filter( Boolean ).join( ` · ` )

}

/**
 * Format rows with widths derived from the visible table values.
 * @param {string[]} headers - Column labels
 * @param {Array<Array<string|number>>} rows - Values to display
 * @returns {{ header: string, divider: string, rows: string[] }}
 */
export const format_table = ( headers, rows ) => {

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
 * @param {boolean} [options.show_flags=false] - Show stored launch modifiers
 * @param {boolean} [options.all=false] - Include diagnostic IDs and raw tmux names
 */
export const print_active_sessions_table = ( tmux_sessions, stored_sessions, {
    title = `Active babysit sessions:`,
    numbered = false,
    numbers = tmux_sessions.map( ( _, index ) => index + 1 ),
    show_flags = false,
    all = false,
} = {} ) => {

    const headers = [
        ... numbered ? [ `#` ] : [] ,
        `NAME`,
        `STATUS`,
        `TMUX`,
        `AGENT`,
        ... show_flags ? [ `FLAGS` ] : [],
        `DIRECTORY`,
        ... all ? [ `ID`, `SESSION` ] : [],
    ]

    const rows = tmux_sessions.map( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( session => session.tmux_session === tmux.name )
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || tmux.name
        const name = stored?.name || session_id
        const status = AGENT_STATUSES.has( tmux.agent_status ) ? tmux.agent_status : `unknown`
        const tmux_status = tmux.attached ? `attached` : `detached`
        const flags = format_session_flags( stored?.modifiers )
        const directory = format_session_directory( stored?.pwd )

        return [
            ... numbered ? [ numbers[index] ] : [] ,
            name,
            status,
            tmux_status,
            agent,
            ... show_flags ? [ flags ] : [],
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
 * @param {Function} [deps.observe_activity_fn] - Fresh pane activity observer
 */
export const cmd_list = async ( {
    flags = {},
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    observe_activity_fn = observe_session_activity,
} = {} ) => {

    const tmux_sessions = await list_sessions_fn()
    const stored_sessions = list_stored_sessions_fn()

    if( tmux_sessions.length === 0 ) {
        console.log( `No active babysit sessions.` )
        return
    }

    const observed_sessions = await observe_activity_fn( tmux_sessions, stored_sessions )

    print_active_sessions_table( observed_sessions, stored_sessions, {
        numbered: true,
        show_flags: true,
        all: flags.all,
    } )

}
