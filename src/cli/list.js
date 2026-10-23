import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'
import { capture_pane } from '../tmux/capture.js'
import { agent_status } from '../babysit/activity.js'
import { strip_ansi } from '../babysit/matcher.js'
import { cached_usage, format_cpu, format_memory, host_cpu_percent } from '../docker/stats.js'
import { paint } from '../utils/color.js'
import { newer_version_available } from './version_check.js'
import { setTimeout as delay } from 'node:timers/promises'

const AGENT_STATUSES = new Set( [ `idle`, `running`, `waiting`, `unknown` ] )
const STATUS_COLORS = { idle: `grey`, running: `green`, waiting: `orange`, stuck: `red`, exited: `grey`, frozen: `yellow` }

/**
 * Color for a share of host capacity: calm below half, warning below 70%, red above.
 * @param {number} ratio - Used divided by capacity
 * @returns {string}
 */
export const load_color = ratio => ratio < 0.5 ? `green` : ratio < 0.7 ? `yellow` : `red`

/**
 * Stored record per tmux session name. Stored lists are newest first, so the
 * newest record wins when a tmux name somehow repeats.
 * @param {Object[]} stored_sessions - Stored Babysit metadata, newest first
 * @returns {Map<string, Object>} Stored session by tmux name
 */
export const stored_by_tmux = stored_sessions => {

    const by_tmux = new Map()
    stored_sessions.forEach( session => by_tmux.has( session.tmux_session ) || by_tmux.set( session.tmux_session, session ) )
    return by_tmux

}

/**
 * Observe current panes instead of trusting options left by an old or stopped
 * monitor. Sample sessions together so listing costs one polling interval.
 * @param {Object[]} sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored agent identities
 * @param {Object} [options] - Pane capture and wait seams
 * @returns {Promise<Object[]>} Sessions with freshly observed activity
 */
// One visible-pane sample; null when tmux could not capture it
const sample_pane = async ( session, capture ) => {
    // Exited fork parents have no pane left to observe
    if( session.exited ) return ``
    try {
        return strip_ansi( await capture( `=${ session.name }:` ) )
    } catch {
        return null
    }
}

export const observe_session_activity = async ( sessions, stored_sessions, {
    capture = capture_pane,
    wait = delay,
} = {} ) => {

    const sample = session => sample_pane( session, capture )

    const before = await Promise.all( sessions.map( sample ) )
    await wait( 1_000 )
    const after = await Promise.all( sessions.map( sample ) )

    const by_tmux = stored_by_tmux( stored_sessions )
    return sessions.map( ( session, index ) => {
        if( session.exited ) return { ...session, agent_status: `exited` }
        const agent = by_tmux.get( session.name )?.agent
        const observed_status = before[index] === null || after[index] === null
            ? `unknown`
            : agent_status( after[index], agent, before[index] === after[index] ? 1 : 0 )

        return { ...session, agent_status: observed_status }
    } )

}

/**
 * Activity observer for redraw loops: each call samples every pane once and
 * remembers when it last changed, so frames never wait out the 1s gap
 * observe_session_activity needs, and early redraws (milliseconds apart) do
 * not mistake a still pane for an idle one. A session seen for the first time
 * keeps the status its monitor last reported until the next frame.
 * @param {Object} [options] - Pane capture and clock seams
 * @returns {Function} observe_activity_fn for render_active_sessions
 */
export const track_session_activity = ( { capture = capture_pane, now = Date.now } = {} ) => {

    // tmux name → { screen, changed_at }
    let previous = new Map()

    return async ( sessions, stored_sessions ) => {

        const screens = await Promise.all( sessions.map( session => sample_pane( session, capture ) ) )
        const by_tmux = stored_by_tmux( stored_sessions )
        const sampled_at = now()
        const before = previous

        previous = new Map( sessions.map( ( session, index ) => {
            const last = before.get( session.name )
            const changed_at = last && last.screen === screens[index] ? last.changed_at : sampled_at
            return [ session.name, { screen: screens[index], changed_at } ]
        } ) )

        return sessions.map( ( session, index ) => {
            if( session.exited ) return { ...session, agent_status: `exited` }
            if( screens[index] === null ) return { ...session, agent_status: `unknown` }
            if( before.get( session.name )?.screen == null ) return session

            const agent = by_tmux.get( session.name )?.agent
            const still_seconds = ( sampled_at - previous.get( session.name ).changed_at ) / 1_000
            return { ...session, agent_status: agent_status( screens[index], agent, still_seconds ) }
        } )

    }

}

// A cell is plain text, { text, color }, or { text, rendered } for pre-colored
// content; padding uses the visible text only.
const cell_text = cell => String( cell?.text ?? cell )
const visible_length = line => line.replace( /\x1b\[[\d;]*m/g, `` ).length
const pad = ( cell, width ) => cell?.rendered
    ? cell.rendered + ` `.repeat( Math.max( 0, width - cell_text( cell ).length ) )
    : paint( cell_text( cell ).padEnd( width ), cell?.color )

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
 * The refusal for acting on an exited fork-parent row: it keeps its number in
 * the list but has nothing left to attach to, archive, close or restart.
 * @param {string} selector - What the user typed
 * @param {Object|undefined} session - Stored record behind the row
 * @param {{ name: string }} row - The exited row
 * @returns {string} Message
 */
export const exited_session_message = ( selector, session, row ) =>
    `Session ${ selector } has exited. Resume it with: babysit resume ${ session?.babysit_id || row.name }`

/**
 * Resolve the fork parent a session should nest under: its `forked_from`
 * launch, followed through resumes to that conversation's current launch.
 * @param {Object|undefined} session - Stored session
 * @param {Map<string, Object>} by_id - Stored sessions by babysit id
 * @returns {Object|null} Current parent launch record
 */
export const fork_parent_of = ( session, by_id ) => {

    let parent = session?.forked_from ? by_id.get( session.forked_from ) : null
    const seen = new Set()
    while( parent?.superseded_by && by_id.has( parent.superseded_by ) && !seen.has( parent.babysit_id ) ) {
        seen.add( parent.babysit_id )
        parent = by_id.get( parent.superseded_by )
    }

    return parent || null

}

/**
 * Display order shared by `list`, `open`, and `close` so numbers agree:
 * archived sessions sink to the bottom of their workspace, and workspaces
 * whose sessions are all archived sink to the bottom of the list. Everything
 * else keeps tmux's order. Forks follow their parent, depth first; an exited
 * parent of a live fork is kept as an `{ exited: true }` row so the tree and
 * its numbers stay whole.
 * @param {Array<{ name: string }>} tmux_sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @returns {Array<{ name: string, exited?: boolean }>} Reordered copy, exited parents included
 */
export const order_active_sessions = ( tmux_sessions, stored_sessions ) => {

    const by_tmux = stored_by_tmux( stored_sessions )
    const by_id = new Map( stored_sessions.map( session => [ session.babysit_id, session ] ) )
    const stored_for = node => by_tmux.get( node.name )
    const live_names = new Set( tmux_sessions.map( tmux => tmux.name ) )

    // Walk each live session's fork ancestry and keep the exited links visible
    const exited = new Map()
    tmux_sessions.forEach( tmux => {
        let parent = fork_parent_of( stored_for( tmux ), by_id )
        while( parent && !live_names.has( parent.tmux_session ) && !exited.has( parent.tmux_session ) ) {
            exited.set( parent.tmux_session, { name: parent.tmux_session, attached: false, exited: true } )
            parent = fork_parent_of( parent, by_id )
        }
    } )

    // Fork links between displayed rows only; a parent off the list makes a root
    const nodes = [ ...tmux_sessions, ...exited.values() ]
    const node_by_id = new Map( nodes.map( node => [ stored_for( node )?.babysit_id, node ] ).filter( ( [ id ] ) => id ) )
    const parent_node = node => node_by_id.get( fork_parent_of( stored_for( node ), by_id )?.babysit_id ) || null

    // The seen set stops at a lineage cycle instead of looping forever
    const root_of = node => {
        const seen = new Set()
        let current = node
        while( parent_node( current ) && !seen.has( current ) ) {
            seen.add( current )
            current = parent_node( current )
        }
        return current
    }

    const children = new Map()
    nodes.forEach( node => {
        const parent = parent_node( node )
        if( parent ) children.set( parent, [ ...children.get( parent ) || [], node ] )
    } )

    // An exited row sorts where its first live descendant would
    const live_index = new Map( tmux_sessions.map( ( tmux, index ) => [ tmux, index ] ) )
    const position = node => live_index.has( node )
        ? live_index.get( node )
        : Math.min( ...( children.get( node ) || [] ).map( position ) ) - 0.5

    const trunk_of = node => stored_for( root_of( node ) )?.pwd || null
    const archived = node => Boolean( stored_for( node )?.archived_at )

    // Workspaces sort by their first live row; fully archived ones sink
    const trunk_first_index = new Map()
    const trunk_all_archived = new Map()
    tmux_sessions.forEach( ( tmux, index ) => {
        const trunk = trunk_of( tmux )
        if( !trunk_first_index.has( trunk ) ) trunk_first_index.set( trunk, index )
        trunk_all_archived.set( trunk, ( trunk_all_archived.get( trunk ) ?? true ) && archived( tmux ) )
    } )

    const rank = node => [
        trunk_all_archived.get( trunk_of( node ) ) ? 1 : 0,
        trunk_first_index.get( trunk_of( node ) ),
        archived( node ) ? 1 : 0,
        position( node ),
    ]

    const compare = ( left, right ) => {
        const index = left.findIndex( ( value, column ) => value !== right[ column ] )
        return index === -1 ? 0 : left[ index ] - right[ index ]
    }

    // Roots keep the workspace/archive order; each subtree follows its root
    const by_position = ( left, right ) => position( left ) - position( right )
    const subtree = node => [ node, ...( children.get( node ) || [] ).sort( by_position ).flatMap( subtree ) ]

    const ordered = nodes
        .filter( node => root_of( node ) === node )
        .map( node => ( { node, rank: rank( node ) } ) )
        .sort( ( left, right ) => compare( left.rank, right.rank ) )
        .flatMap( ( { node } ) => subtree( node ) )

    // Corrupt lineage (a cycle) has no root; never drop a live session's number
    const emitted = new Set( ordered )
    return [ ...ordered, ...tmux_sessions.filter( tmux => !emitted.has( tmux ) ) ]

}

/**
 * Tree glyphs for the session list. Plain ASCII on dumb terminals.
 * @param {Object} [env=process.env] - Environment to inspect
 * @returns {{ branch: string, last: string, pipe: string }} Leaf prefixes and the ancestor rail
 */
const tree_glyphs = ( env = process.env ) => env.TERM === `dumb`
    ? { branch: `|- `, last: `\\- `, pipe: `|  ` }
    : { branch: `├─ `, last: `└─ `, pipe: `│  ` }

/**
 * Tree prefix for each row's NAME cell, from the fork parents present in
 * this (possibly filtered) display order. Roots get no prefix.
 * @param {Array<{ name: string }>} rows - Sessions in display order
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @param {Object} [env=process.env] - Environment for glyph selection
 * @returns {{ prefixes: string[], roots: number[] }} Prefix and root row index per row
 */
export const fork_tree_prefixes = ( rows, stored_sessions, env = process.env ) => {

    const by_id = new Map( stored_sessions.map( session => [ session.babysit_id, session ] ) )
    const by_tmux = stored_by_tmux( stored_sessions )
    const stored_for = row => by_tmux.get( row.name )
    const row_of_id = new Map( rows.map( ( row, index ) => [ stored_for( row )?.babysit_id, index ] ).filter( ( [ id ] ) => id ) )

    // Only a parent displayed earlier can own a row; anything else is a root
    const parents = rows.map( ( row, index ) => {
        const parent_id = fork_parent_of( stored_for( row ), by_id )?.babysit_id
        const parent = parent_id ? row_of_id.get( parent_id ) : undefined
        return parent !== undefined && parent < index ? parent : null
    } )
    const has_later_sibling = index => parents.some( ( parent, other ) => other > index && parent === parents[ index ] )

    // Each ancestor with a later sibling draws a rail; the row itself a branch or last glyph
    const { branch, last, pipe } = tree_glyphs( env )
    const prefix_for = index => {
        if( parents[ index ] === null ) return ``
        const own = has_later_sibling( index ) ? branch : last
        const ancestors = []
        for( let ancestor = parents[ index ]; parents[ ancestor ] !== null; ancestor = parents[ ancestor ] ) {
            ancestors.unshift( has_later_sibling( ancestor ) ? pipe : `   ` )
        }
        return `${ ancestors.join( `` ) }${ own }`
    }
    const root_for = index => parents[ index ] === null ? index : root_for( parents[ index ] )

    return {
        prefixes: rows.map( ( _, index ) => prefix_for( index ) ),
        roots: rows.map( ( _, index ) => root_for( index ) ),
    }

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
 * capacity when a sample recorded it (CPU is already a share of the host).
 * @param {string[]} headers - Column labels, to place the cells
 * @param {Array<Object|null>} usages - Cached usage per session
 * @returns {Array} Row with empty cells outside NAME/CPU/MEM
 */
export const usage_totals_row = ( headers, usages ) => {

    const samples = usages.filter( Boolean )
    const cpu = samples.reduce( ( total, usage ) => total + host_cpu_percent( usage ), 0 )
    const memory = samples.reduce( ( total, usage ) => total + usage.memory_bytes, 0 )
    const host_cpus = Math.max( 0, ...samples.map( usage => usage.host_cpus || 0 ) )
    const host_memory = Math.max( 0, ...samples.map( usage => usage.host_memory_bytes || 0 ) )

    const row = headers.map( () => `` )
    row[ headers.indexOf( `NAME` ) ] = `Total`
    row[ headers.indexOf( `CPU` ) ] = samples.length
        ? { text: format_cpu( cpu ), color: host_cpus ? load_color( cpu / 100 ) : null }
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
 * @param {boolean} [options.open_hint=numbered] - Print the `babysit open` hint under numbered trees
 * @param {number[]} [options.numbers] - Global selectors for a filtered tree
 * @param {boolean} [options.show_flags=false] - Show stored launch modifiers
 * @param {boolean} [options.show_usage=false] - Show cached container CPU/MEM and a totals row
 * @param {Array<{ header: string, cell: Function }>} [options.extra_columns=[]] - Caller columns after CPU/MEM; `cell( stored )` gets the session's stored record (maybe undefined) and returns a cell
 * @param {boolean} [options.all=false] - Include tmux attachment, diagnostic IDs and raw tmux names
 * @param {number} [options.now] - Epoch milliseconds for usage staleness
 */
export const print_active_sessions_table = ( tmux_sessions, stored_sessions, {
    title = `Active babysit sessions:`,
    numbered = false,
    open_hint = numbered,
    numbers = tmux_sessions.map( ( _, index ) => index + 1 ),
    show_flags = false,
    show_usage = false,
    extra_columns = [],
    all = false,
    now = Date.now(),
} = {} ) => {

    const headers = [
        ... numbered ? [ `#` ] : [] ,
        `NAME`,
        `STATUS`,
        `AGENT`,
        ... show_usage ? [ `CPU`, `MEM` ] : [],
        ... extra_columns.map( column => column.header ),
        ... show_flags ? [ `FLAGS` ] : [],
        ... all ? [ `TMUX`, `ID`, `SESSION` ] : [],
    ]

    // Forks nest under their parent inside the NAME column and share its trunk
    const { prefixes, roots } = fork_tree_prefixes( tmux_sessions, stored_sessions )
    const by_tmux = stored_by_tmux( stored_sessions )
    const stored_for = tmux => by_tmux.get( tmux.name )

    const sessions = tmux_sessions.map( ( tmux, index ) => {

        // Cross-reference with stored session metadata
        const stored = stored_for( tmux )
        const agent = stored?.agent || `unknown`
        const session_id = stored?.agent_session_id || stored?.babysit_id || tmux.name
        const name = stored?.name || session_id
        // An exited fork parent has no activity; a frozen container (`babysit
        // freeze`) has none either; a `babysit stuck` flag outranks observed
        // activity until the user types.
        const status = tmux.exited
            ? `exited`
            : stored?.frozen_at
                ? `frozen`
                : stored?.stuck_at
                    ? `stuck`
                    : AGENT_STATUSES.has( tmux.agent_status ) ? tmux.agent_status : `unknown`
        const tmux_status = tmux.exited ? `exited` : tmux.attached ? `attached` : `detached`
        const flags = format_session_flags( stored?.modifiers )
        const usage = show_usage && !tmux.exited ? cached_usage( stored, now ) : null
        const archived = Boolean( stored?.archived_at )

        return {
            pwd: stored_for( tmux_sessions[ roots[index] ] )?.pwd || null,
            usage,
            archived,
            leaf: [
                ... numbered ? [ numbers[index] ] : [] ,
                `${ prefixes[index] }${ name }`,
                // Archived rows are dimmed as a whole, so the status keeps no color of its own.
                { text: status, color: archived ? null : STATUS_COLORS[ status ] },
                agent,
                ... show_usage ? [ usage ? format_cpu( host_cpu_percent( usage ) ) : `-`, usage ? format_memory( usage.memory_bytes ) : `-` ] : [],
                ... extra_columns.map( column => column.cell( stored ) ),
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
    if( open_hint ) console.log( `Open one with: babysit open <number>\n` )

}

/**
 * Render the active-session tree once. Shared by `list` and `watch`.
 * @param {Object} [options]
 * @param {boolean} [options.all=false] - Diagnostic columns
 * @param {boolean} [options.hide_archived=false] - Drop archived rows; numbers stay global
 * @param {boolean} [options.open_hint=true] - Print the `babysit open` hint
 * @param {Object[]} [options.extra_columns=[]] - Caller columns, see print_active_sessions_table
 * @param {Function} [options.before_print] - Runs after sampling, right before output
 * @param {Function} [options.list_sessions_fn] - Active tmux session loader
 * @param {Function} [options.list_stored_sessions_fn] - Stored metadata loader
 * @param {Function} [options.observe_activity_fn] - Fresh pane activity observer
 * @param {Function} [options.version_check_fn] - Newer-release lookup
 * @returns {Promise<{ targets: Map<number, string> }>} Shown selectors that can be opened (exited fork parents
 * excluded), each pinned to its babysit id (tmux name when unrecorded) so a list that shifts cannot open another session
 */
export const render_active_sessions = async ( {
    all = false,
    hide_archived = false,
    open_hint = true,
    extra_columns = [],
    before_print = () => {},
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    observe_activity_fn = observe_session_activity,
    version_check_fn = newer_version_available,
} = {} ) => {

    const stored_sessions = list_stored_sessions_fn()
    const ordered_sessions = order_active_sessions( await list_sessions_fn(), stored_sessions )

    // Numbers stay global so `babysit open <n>` means the same thing everywhere.
    const by_tmux = stored_by_tmux( stored_sessions )
    const is_archived = tmux => Boolean( by_tmux.get( tmux.name )?.archived_at )
    const tmux_sessions = hide_archived ? ordered_sessions.filter( tmux => !is_archived( tmux ) ) : ordered_sessions
    const numbers = tmux_sessions.map( tmux => ordered_sessions.indexOf( tmux ) + 1 )

    if( tmux_sessions.length === 0 ) {
        before_print()
        // Archived sessions still run; tell the watcher where they went.
        console.log( ordered_sessions.length
            ? `No unarchived babysit sessions. Run babysit list to see archived ones.`
            : `No active babysit sessions.` )
        return { targets: new Map() }
    }

    const observed_sessions = await observe_activity_fn( tmux_sessions, stored_sessions )
    before_print()

    // CPU/MEM come from the cache each session's monitor keeps; no Docker call here.
    print_active_sessions_table( observed_sessions, stored_sessions, {
        numbered: true,
        numbers,
        show_flags: true,
        show_usage: true,
        extra_columns,
        open_hint,
        all,
    } )

    // Cached lookup: never a network wait in front of the table.
    const { latest } = version_check_fn()
    if( latest ) console.log( paint( `New babysit version available: ${ latest } (run babysit update)`, `orange` ) + `\n` )

    const targets = tmux_sessions
        .map( ( tmux, index ) => [ numbers[index], by_tmux.get( tmux.name )?.babysit_id || tmux.name, tmux.exited ] )
        .filter( ( [ , , exited ] ) => !exited )
        .map( ( [ number, target ] ) => [ number, target ] )
    return { targets: new Map( targets ) }

}

/**
 * List all active babysit sessions
 * @param {Object} [cmd] - Parsed command
 * @param {Object} [cmd.flags] - Parsed list display flags
 * @param {Object} [deps] - render_active_sessions seams, flattened into cmd for tests
 */
export const cmd_list = async ( { flags = {}, ...deps } = {} ) => {

    // The live view moved to `babysit watch`.
    if( flags.watch ) {
        console.error( `babysit list --watch is gone; run babysit watch` )
        process.exitCode = 1
        return
    }

    return render_active_sessions( { ...deps, all: flags.all } )

}
