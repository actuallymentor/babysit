import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'
import { capture_pane } from '../tmux/capture.js'
import { agent_status } from '../babysit/activity.js'
import { strip_ansi } from '../babysit/matcher.js'
import { cached_usage, format_cpu, format_memory } from '../docker/stats.js'
import { paint } from '../utils/color.js'
import { setTimeout as delay } from 'node:timers/promises'

const AGENT_STATUSES = new Set( [ `idle`, `running`, `waiting`, `unknown` ] )
const STATUS_COLORS = { idle: `grey`, running: `green`, waiting: `orange`, stuck: `red` }

/**
 * Color for a share of host capacity: calm below half, warning below 70%, red above.
 * @param {number} ratio - Used divided by capacity
 * @returns {string}
 */
export const load_color = ratio => ratio < 0.5 ? `green` : ratio < 0.7 ? `yellow` : `red`

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

// A cell is plain text or { text, color }; padding uses the visible text only.
const cell_text = cell => String( cell?.text ?? cell )
const visible_length = line => line.replace( /\x1b\[[\d;]*m/g, `` ).length
const pad = ( cell, width ) => paint( cell_text( cell ).padEnd( width ), cell?.color )

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
 * Display order shared by `list`, `open`, and `close` so numbers agree:
 * archived sessions sink to the bottom of their workspace, and workspaces
 * whose sessions are all archived sink to the bottom of the list. Everything
 * else keeps tmux's order.
 * @param {Array<{ name: string }>} tmux_sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @returns {Array<{ name: string }>} Reordered copy
 */
export const order_active_sessions = ( tmux_sessions, stored_sessions ) => {

    const stored_for = tmux => stored_sessions.find( session => session.tmux_session === tmux.name )
    const trunk_of = tmux => stored_for( tmux )?.pwd || null
    const archived = tmux => Boolean( stored_for( tmux )?.archived_at )

    const trunk_first_index = new Map()
    const trunk_all_archived = new Map()
    tmux_sessions.forEach( ( tmux, index ) => {
        const trunk = trunk_of( tmux )
        if( !trunk_first_index.has( trunk ) ) trunk_first_index.set( trunk, index )
        trunk_all_archived.set( trunk, ( trunk_all_archived.get( trunk ) ?? true ) && archived( tmux ) )
    } )

    const rank = ( tmux, index ) => [
        trunk_all_archived.get( trunk_of( tmux ) ) ? 1 : 0,
        trunk_first_index.get( trunk_of( tmux ) ),
        archived( tmux ) ? 1 : 0,
        index,
    ]

    const compare = ( left, right ) => {
        const position = left.findIndex( ( value, index ) => value !== right[ index ] )
        return position === -1 ? 0 : left[ position ] - right[ position ]
    }

    return tmux_sessions
        .map( ( tmux, index ) => ( { tmux, rank: rank( tmux, index ) } ) )
        .sort( ( left, right ) => compare( left.rank, right.rank ) )
        .map( ( { tmux } ) => tmux )

}

/**
 * Format rows with widths derived from the visible table values.
 * @param {string[]} headers - Column labels
 * @param {Array<Array<string|number|{ text: string, color?: string }>>} rows - Values to display
 * @returns {{ header: string, divider: string, rows: string[] }}
 */
export const format_table = ( headers, rows ) => {

    const column_widths = headers.map( ( header, index ) => Math.max(
        String( header ).length,
        ...rows.map( row => cell_text( row[index] ).length )
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
 * Tree glyphs for the session list. Plain ASCII on dumb terminals.
 * @param {Object} [env=process.env] - Environment to inspect
 * @returns {{ branch: string, last: string }} Leaf prefixes
 */
const tree_glyphs = ( env = process.env ) => env.TERM === `dumb`
    ? { branch: `|- `, last: `\\- ` }
    : { branch: `├─ `, last: `└─ ` }

/**
 * Group aligned table rows under their trunk label, keeping first-seen order.
 * Each leaf row is prefixed with a branch glyph; the header receives the same
 * indent so columns line up across trunks.
 * @param {string[]} headers - Leaf column labels
 * @param {Array<Array<string|number>>} rows - Leaf values, one per session
 * @param {string[]} trunks - Trunk label per row (same index as rows)
 * @param {Object} [options]
 * @param {Object} [options.env] - Environment for glyph selection
 * @param {Array|null} [options.footer] - Summary row aligned under the columns
 * @param {boolean[]} [options.dim] - Per-row archived flag; a trunk dims when all its rows are
 * @returns {{ header: string, divider: string, lines: string[], footer: string|null }} Rendered tree
 */
export const format_session_tree = ( headers, rows, trunks, { env = process.env, footer = null, dim = [] } = {} ) => {

    const table = format_table( headers, footer ? [ ...rows, footer ] : rows )
    const footer_line = footer ? `${ ` `.repeat( tree_glyphs( env ).branch.length ) }${ table.rows.pop() }` : null
    const glyphs = tree_glyphs( env )
    const indent = ` `.repeat( glyphs.branch.length )

    // Trunks in order of first appearance; leaves keep their original row order.
    // A blank line separates trunks so each workspace reads as its own block.
    const trunk_order = [ ...new Set( trunks ) ]
    const lines = trunk_order.flatMap( ( trunk, position ) => {
        const indices = trunks.map( ( value, index ) => value === trunk ? index : -1 ).filter( index => index >= 0 )
        const trunk_dim = indices.every( index => dim[index] )
        return [
            ...position ? [ `` ] : [],
            paint( trunk, trunk_dim ? `dim` : null ),
            ...indices.map( ( row, leaf_position ) => paint(
                `${ leaf_position === indices.length - 1 ? glyphs.last : glyphs.branch }${ table.rows[row] }`,
                dim[row] ? `dim` : null
            ) ),
        ]
    } )

    const header = `${ indent }${ table.header }`
    const width = Math.max( header.length, ...lines.map( visible_length ) )

    return { header, divider: `-`.repeat( width ), lines, footer: footer_line }

}

/**
 * Label each workspace with its compact directory, falling back to the full
 * path when two different workspaces would otherwise share a trunk.
 * @param {Array<string|null>} pwds - Full working directory per session
 * @returns {string[]} Trunk label per session
 */
export const trunk_labels = pwds => {

    const compact = pwds.map( format_session_directory )
    const collides = pwd => pwds.some( ( other, index ) =>
        other !== pwd && compact[index] === format_session_directory( pwd )
    )

    return pwds.map( ( pwd, index ) => pwd && collides( pwd ) ? pwd : compact[index] )

}

/**
 * Sum cached usage into a table row, colored against the Docker host's
 * capacity when a sample recorded it (CPU capacity is cores × 100%).
 * @param {string[]} headers - Column labels, to place the cells
 * @param {Array<Object|null>} usages - Cached usage per session
 * @returns {Array} Row with empty cells outside NAME/CPU/MEM
 */
export const usage_totals_row = ( headers, usages ) => {

    const samples = usages.filter( Boolean )
    const cpu = samples.reduce( ( total, usage ) => total + usage.cpu_percent, 0 )
    const memory = samples.reduce( ( total, usage ) => total + usage.memory_bytes, 0 )
    const host_cpus = Math.max( 0, ...samples.map( usage => usage.host_cpus || 0 ) )
    const host_memory = Math.max( 0, ...samples.map( usage => usage.host_memory_bytes || 0 ) )

    const row = headers.map( () => `` )
    row[ headers.indexOf( `NAME` ) ] = `Total`
    row[ headers.indexOf( `CPU` ) ] = samples.length
        ? { text: format_cpu( cpu ), color: host_cpus ? load_color( cpu / ( host_cpus * 100 ) ) : null }
        : `-`
    row[ headers.indexOf( `MEM` ) ] = samples.length
        ? { text: format_memory( memory ), color: host_memory ? load_color( memory / host_memory ) : null }
        : `-`
    return row

}

/**
 * Print active sessions as a tree: one trunk per workspace directory, one
 * numbered leaf per session with the remaining columns. Shared by `list`,
 * `open`, and `close` so selector numbers read the same everywhere.
 * @param {Array<{ name: string, attached: boolean }>} tmux_sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @param {Object} [options]
 * @param {string} [options.title] - Tree title
 * @param {boolean} [options.numbered=false] - Show active-list selectors
 * @param {number[]} [options.numbers] - Global selectors for a filtered tree
 * @param {boolean} [options.show_flags=false] - Show stored launch modifiers
 * @param {boolean} [options.show_usage=false] - Show cached container CPU/MEM and a totals row
 * @param {boolean} [options.all=false] - Include tmux attachment, diagnostic IDs and raw tmux names
 * @param {number} [options.now] - Epoch milliseconds for usage staleness
 */
export const print_active_sessions_table = ( tmux_sessions, stored_sessions, {
    title = `Active babysit sessions:`,
    numbered = false,
    numbers = tmux_sessions.map( ( _, index ) => index + 1 ),
    show_flags = false,
    show_usage = false,
    all = false,
    now = Date.now(),
} = {} ) => {

    const headers = [
        ... numbered ? [ `#` ] : [] ,
        `NAME`,
        `STATUS`,
        `AGENT`,
        ... show_usage ? [ `CPU`, `MEM` ] : [],
        ... show_flags ? [ `FLAGS` ] : [],
        ... all ? [ `TMUX`, `ID`, `SESSION` ] : [],
    ]

    const sessions = tmux_sessions.map( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_sessions.find( session => session.tmux_session === tmux.name )
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || tmux.name
        const name = stored?.name || session_id
        // A `babysit stuck` flag outranks observed activity until the user types.
        const status = stored?.stuck_at
            ? `stuck`
            : AGENT_STATUSES.has( tmux.agent_status ) ? tmux.agent_status : `unknown`
        const tmux_status = tmux.attached ? `attached` : `detached`
        const flags = format_session_flags( stored?.modifiers )
        const usage = show_usage ? cached_usage( stored, now ) : null
        const archived = Boolean( stored?.archived_at )

        return {
            pwd: stored?.pwd || null,
            usage,
            archived,
            leaf: [
                ... numbered ? [ numbers[index] ] : [] ,
                name,
                // Archived rows are dimmed as a whole, so the status keeps no color of its own.
                { text: status, color: archived ? null : STATUS_COLORS[ status ] },
                agent,
                ... show_usage ? [ usage ? format_cpu( usage.cpu_percent ) : `-`, usage ? format_memory( usage.memory_bytes ) : `-` ] : [],
                ... show_flags ? [ flags ] : [],
                ... all ? [ tmux_status, session_id, tmux.name ] : [],
            ],
        }

    } )

    const tree = format_session_tree(
        headers,
        sessions.map( session => session.leaf ),
        trunk_labels( sessions.map( session => session.pwd ) ),
        {
            footer: show_usage ? usage_totals_row( headers, sessions.map( session => session.usage ) ) : null,
            dim: sessions.map( session => session.archived ),
        }
    )

    console.log( `\n${ title }\n` )
    console.log( `  ${ tree.header }` )
    console.log( `  ${ tree.divider }` )
    tree.lines.forEach( line => console.log( line ? `  ${ line }` : `` ) )
    if( tree.footer ) {
        console.log( `` )
        console.log( `  ${ tree.footer }` )
    }

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
 * @param {Function} [deps.wait_fn] - Delay between --watch redraws
 * @param {Function} [deps.write_fn] - Raw terminal writer for --watch
 * @param {number} [deps.watch_rounds] - Redraw count for --watch; endless by default
 */
export const cmd_list = async ( {
    flags = {},
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    observe_activity_fn = observe_session_activity,
    wait_fn = delay,
    write_fn = text => process.stdout.write( text ),
    watch_rounds = Infinity,
} = {} ) => {

    // CPU/MEM come from the cache each session's monitor keeps; no Docker call here.
    const print_sessions = ( observed_sessions, stored_sessions, numbers ) => print_active_sessions_table( observed_sessions, stored_sessions, {
        numbered: true,
        numbers,
        show_flags: true,
        show_usage: true,
        all: flags.all,
    } )

    const render = async ( { before_print = () => {} } = {} ) => {

        const stored_sessions = list_stored_sessions_fn()
        const ordered_sessions = order_active_sessions( await list_sessions_fn(), stored_sessions )

        // --watch is a live dashboard: archived sessions are noise there. Numbers
        // stay global so `babysit open <n>` means the same thing as in a plain list.
        const is_archived = tmux => Boolean( stored_sessions.find( session => session.tmux_session === tmux.name )?.archived_at )
        const tmux_sessions = flags.watch ? ordered_sessions.filter( tmux => !is_archived( tmux ) ) : ordered_sessions
        const numbers = tmux_sessions.map( tmux => ordered_sessions.indexOf( tmux ) + 1 )

        if( tmux_sessions.length === 0 ) {
            before_print()
            console.log( `No active babysit sessions.` )
            return
        }

        const observed_sessions = await observe_activity_fn( tmux_sessions, stored_sessions )
        before_print()
        print_sessions( observed_sessions, stored_sessions, numbers )

    }

    if( !flags.watch ) return render()

    // --watch redraws in place on the real terminal, so every color survives;
    // external `watch` pipes the output and older versions drop 256-color codes.
    // Clearing only right before printing keeps the old frame up while sampling.
    for( let round = 0; round < watch_rounds; round++ ) {
        await render( { before_print: () => write_fn( `\x1b[H\x1b[J` ) } )
        console.log( `Refreshing every 2s; Ctrl+C to stop.` )
        await wait_fn( 2_000 )
    }

}
