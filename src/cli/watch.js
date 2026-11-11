import { watch } from 'node:fs'
import { spawn } from 'node:child_process'

import { opencode_model_flag } from '../agents/opencode.js'
import { DEFAULT_ACCOUNT, collect_account_usage, list_claude_accounts } from './claude_accounts.js'
import { relative_time, usage_color } from '../docker/assets/usage/format.mjs'
import { paint } from '../utils/color.js'
import { log } from '../utils/log.js'
import { render_active_sessions, track_session_activity } from './list.js'
import { cmd_open } from './open.js'
import { take_exit_notice, watch_follows } from './exit_notice.js'
import { foreground_attach_count, mark_read, shelve_session } from '../tmux/session.js'
import { SESSIONS_DIR } from '../utils/paths.js'
import { update_session } from '../sessions/store.js'
import { disk_warnings, read_disk_health, refresh_disk_health } from '../disk_health.js'

const FRAME_MS = 1_000
// Registry writes come in bursts; redraw once they settle
const SETTLE_MS = 100
// With 1 and 12 on screen, how long `1` waits for a second digit
const CHORD_MS = 700
const SIGNALS = [ `SIGINT`, `SIGTERM`, `SIGHUP` ]
// CSI (ESC [ … final), SS3 (ESC O x) and Alt+key (ESC x) sequences
const ESCAPE_SEQUENCE = /(\x1b(?:\[[0-?]*[ -/]*[@-~]|O[\s\S]|[ -~]))/
// Arrow keys, in normal and application cursor mode; every other sequence is dropped
const ESCAPE_SEQUENCE_ALL = /\x1b\[[\d;]*[A-Za-z]/g
const ARROWS = { '\x1b[A': `up`, '\x1bOA': `up`, '\x1b[B': `down`, '\x1bOB': `down` }
export const USAGE_REFRESH_MS = 5 * 60_000

// The storage check itself runs at most hourly; this is only how often to ask
const DISK_HEALTH_POLL_MS = 60_000
const BAR_CELLS = 10
// How long a result or the "press r again" prompt stays up
const NOTICE_MS = 4_000
const ARM_MS = 3_000

const HELP = [
    `Keyboard shortcuts`,
    ``,
    `  ↑ ↓        select a session`,
    `  enter      open the selected session`,
    `  0-9        type a session number to open it`,
    `  space      mark an unread session read`,
    `  e          move to the idle list (until its next finished turn)`,
    `  i          show / hide each session's task title`,
    `  f          freeze / unfreeze (Docker sessions)`,
    `  r          restart; rr when the session is not idle`,
    `  ?          this help`,
    `  q, ctrl+c  quit`,
]

/**
 * Run a babysit command in the background, outliving Ctrl+C in this terminal
 * (a restart takes minutes and must not be cut short). Output stays off the
 * dashboard; its first line is the result (errors lead, stack frames follow).
 * @param {string[]} args - babysit arguments
 * @returns {Promise<{ ok: boolean, out: string }>}
 */
const run_babysit = args => new Promise( resolve => {

    // Bun-compiled binaries put a synthetic /$bunfs path in argv[1]; node puts the script
    const script = process.argv[1] || ``
    const compiled = script.startsWith( `/$bunfs` ) || script === ``
    const child = spawn( process.execPath, compiled ? args : [ script, ...args ], { detached: true, stdio: [ `ignore`, `pipe`, `pipe` ] } )

    let output = ``
    const collect = chunk => output += chunk
    child.stdout.on( `data`, collect )
    child.stderr.on( `data`, collect )
    child.on( `error`, error => resolve( { ok: false, out: error.message } ) )
    child.on( `close`, code => resolve( { ok: code === 0, out: output.replace( ESCAPE_SEQUENCE_ALL, `` ).trim().split( `\n` )[0] || `` } ) )
    child.unref()

} )

const visible_length = text => text.replace( /\x1b\[[\d;]*m/g, `` ).length
const pad = ( text, width ) => text + ` `.repeat( Math.max( 0, width - visible_length( text ) ) )
const is_number = value => typeof value === `number` && Number.isFinite( value )
const given = value => value !== null && value !== undefined
// Provider text lands on the terminal verbatim; strip controls like `babysit usage` does.
const safe_text = value => String( value ?? `` ).replace( /[\x00-\x1f\x7f-\x9f]/g, `` )
// Providers send money and credits as long decimals; two places is what humans read.
const decimals = value => /^-?\d+\.\d{3,}$/.test( String( value ) ) ? String( +Number( value ).toFixed( 2 ) ) : safe_text( value )

/**
 * Humane window names: `five_hour` → `5h`, `codex / 10080 min` → `7d`.
 * The agent's own name is dropped since the row already says it.
 * @param {string} name - Provider limit name
 * @param {string} agent - Agent the row belongs to
 * @returns {string}
 */
export const short_limit_name = ( name, agent ) => String( name )
    .replace( new RegExp( `^${ agent } / ` ), `` )
    .replace( /(\d+) min\b/, ( _, minutes ) => {
        const hours = minutes / 60
        return hours >= 24 && hours % 24 === 0 ? `${ hours / 24 }d` : hours >= 1 ? `${ hours }h` : `${ minutes }m`
    } )
    .replace( /^API key \/ /, `` )
    .replace( /^five_hour$|^session$/, `5h` )
    .replace( /^seven_day_?|^weekly_all$|^weekly_scoped(?: \/ )?/, `7d ` )
    .replace( /_/g, ` ` )
    .trim()

/**
 * Share of a limit used: the provider's own percentage, else used ÷ limit.
 * @param {Object} limit - Provider limit
 * @returns {number|null} 0–100, or null when the limit is not metered
 */
export const limit_percent = limit => {

    if( is_number( limit.used_percent ) ) return limit.used_percent
    if( is_number( limit.remaining_percent ) ) return 100 - limit.remaining_percent

    const used = Number( limit.used )
    const cap = Number( limit.limit )
    return given( limit.used ) && given( limit.limit ) && Number.isFinite( used ) && cap > 0 ? used / cap * 100 : null

}

/**
 * Headroom waterfall on the worst remaining %, first hit wins.
 * Thresholds are exclusive upper bounds: 5% left is `low`, not `critical`.
 */
export const USAGE_LEVELS = [
    { below: 5, label: `critical`, color: `red` },
    { below: 20, label: `low`, color: `orange` },
    { below: 40, label: `fine`, color: `green` },
    { below: Infinity, label: `plenty`, color: `green` },
]

/**
 * Headroom level for one session: the worst remaining share across its rate
 * windows. Spend caps, credit balances and lifetime spend carry no
 * `kind: 'window'` marker (see providers.mjs), so they never count.
 * @param {Object[]|null} limits - Provider limits for the session's account
 * @returns {{ label: string, color: string, remaining: number }|null} Level, or null without metered windows
 */
export const usage_level = limits => {

    const remaining = ( limits || [] )
        .filter( limit => limit.kind === `window` )
        .map( limit_percent )
        .filter( is_number )
        // Overspent windows report >100% used; headroom bottoms out at 0
        .map( used => Math.max( 0, 100 - used ) )
    if( !remaining.length ) return null

    const worst = Math.min( ...remaining )
    const { label, color } = USAGE_LEVELS.find( level => worst < level.below )
    return { label, color, remaining: worst }

}

/**
 * The provider an OpenCode session bills: the `provider/` half of the model
 * its launch spec records (start.js fills in the default model when no flag
 * names one).
 * @param {Object|undefined} session - Stored session record
 * @returns {string|null} Provider id, or null when the record names no model
 */
const opencode_provider = session => opencode_model_flag( session?.launch_spec?.args || [] )?.split( `/` )[0] || null

/**
 * The limits that bound one session: every healthy report entry for its agent.
 * With several Claude accounts the report holds one entry per account, so a
 * session only counts the account it runs on (`default` when unrecorded). A
 * single-account entry carries no name and stands for `default`: it must not
 * lend its numbers to a session on a named account.
 * OpenCode spans providers, so a session only counts the provider its model
 * runs on, and nothing when that is unknown rather than the worst of all.
 * @param {Object|null} report - collect_usage result
 * @param {Object|undefined} session - Stored session record
 * @returns {Object[]} Limits, empty when the report has nothing for the session
 */
export const session_usage_limits = ( report, session ) => {

    const provider = session?.agent === `opencode` ? opencode_provider( session ) : undefined
    if( provider === null ) return []

    return ( report?.agents || [] )
        .filter( result => result.agent === session?.agent && result.status === `ok` )
        // Codex/OpenCode sessions carry a Claude account too, for nested claude only
        .filter( result => session?.agent !== `claude` || ( result.account || DEFAULT_ACCOUNT ) === ( session?.claude_account || DEFAULT_ACCOUNT ) )
        .filter( result => provider === undefined || result.provider === provider )
        .flatMap( result => result.limits || [] )

}

/**
 * Ten-cell meter colored like `babysit usage`: calm, warning, red.
 * @param {number} percent - Used share, 0–100
 * @returns {string}
 */
export const usage_bar = percent => {

    const filled = Math.round( Math.min( 100, Math.max( 0, percent ) ) / 100 * BAR_CELLS )
    return paint( `▰`.repeat( filled ), usage_color( percent ) ) + paint( `▱`.repeat( BAR_CELLS - filled ), `dim` )

}

/**
 * USAGE cell for one session row: the account usage bar, filled by the share
 * of the worst rate window already used, or a dim dash while the report loads
 * or holds nothing for the agent. `text` is the plain bar (for column width);
 * `rendered` is the colored one.
 * @param {Object|null} report - collect_usage result
 * @param {Object|undefined} session - Stored session record
 * @returns {{ text: string, color?: string, rendered?: string }}
 */
export const usage_cell = ( report, session ) => {

    const level = usage_level( session_usage_limits( report, session ) )
    if( !level ) return { text: `—`, color: `dim` }

    const used = 100 - level.remaining
    const filled = Math.round( Math.min( 100, Math.max( 0, used ) ) / 100 * BAR_CELLS )
    return { text: `▰`.repeat( filled ) + `▱`.repeat( BAR_CELLS - filled ), rendered: usage_bar( used ) }

}

/**
 * One metered row per limit, agent named on its first row only.
 * Credential-less agents are skipped; problems keep a short reason.
 * @param {Object|null} report - collect_usage result, null while loading
 * @param {Object} [options]
 * @param {number} [options.now=Date.now()] - Epoch ms for reset countdowns and age
 * @param {string|null} [options.error] - Last refresh failure
 * @returns {string[]} Lines to print
 */
export const format_usage_panel = ( report, { now = Date.now(), error = null } = {} ) => {

    const age = report?.fetched_at ? relative_time( now, report.fetched_at )?.replace( /^in /, `` ) : null
    const freshness = report ? age === `now` ? `just now` : `${ age } ago` : error ? `unavailable` : `loading…`
    const title = `Account usage ${ paint( `· ${ freshness }`, `dim` ) }`
    const failure = error ? [ paint( `  refresh failed: ${ error }`, `red` ) ] : []
    if( !report ) return [ title, ...failure ]

    const rows = []
    const notes = []

    report.agents.forEach( result => {

        // OpenCode spans providers; the others map one agent to one account.
        const label = safe_text( result.account ? `claude / ${ result.account }`
            : result.agent === `opencode` && result.provider ? `opencode/${ result.provider }` : result.agent )
        const first_row = rows.length

        // Agents without credentials are noise here; `babysit usage` lists them.
        if( result.status === `unauthenticated` ) return
        if( result.status !== `ok` ) {
            const status = paint( result.status, result.status === `error` ? `red` : `yellow` )
            return notes.push( `${ label } ${ status } ${ paint( safe_text( result.message ), `dim` ) }` )
        }

        result.limits.forEach( limit => {

            // Only metered limits make the dashboard: balances and lifetime spend stay in `babysit usage`.
            const percent = limit_percent( limit )
            if( percent === null ) return

            const unit = limit.unit ? ` ${ safe_text( limit.unit ) }` : ``
            const amount = given( limit.used ) && given( limit.limit ) ? `${ decimals( limit.used ) } / ${ decimals( limit.limit ) }${ unit }` : null
            const reset = limit.resets_at ? relative_time( limit.resets_at, now ) : null
            const tail = [ reset && `↻ ${ reset.replace( /^in /, `` ) }`, amount ].filter( Boolean ).join( `  ` )

            rows.push( [
                rows.length === first_row ? label : ``,
                short_limit_name( safe_text( limit.name ), result.agent ),
                usage_bar( percent ),
                paint( `${ Math.round( percent ) }%`.padStart( 4 ), usage_color( percent ) ),
                paint( tail, `dim` ),
            ] )

        } )

    } )

    const widths = rows[0]?.map( ( _, column ) => Math.max( ...rows.map( row => visible_length( row[ column ] ) ) ) ) || []
    const lines = rows.map( row => `  ${ row.map( ( cell, column ) => pad( cell, widths[ column ] ) ).join( `  ` ).trimEnd() }` )

    return [
        title,
        ...lines,
        ...notes.map( note => `  ${ note }` ),
        ...failure,
    ]

}

/**
 * Collect what fn logs instead of printing it, one entry per line.
 * @param {Function} fn - Async printer
 * @returns {Promise<{ lines: string[], result: * }>}
 */
const collect_lines = async fn => {

    const original = console.log
    const lines = []
    console.log = ( ...parts ) => lines.push( ...parts.join( ` ` ).split( `\n` ) )
    try {
        const result = await fn()
        return { lines, result }
    } finally {
        console.log = original
    }

}

// Home, then each line clearing its own tail, then the rest of the screen:
// the old frame stays up until overwritten, so nothing flickers. \r\n keeps
// lines aligned while stdin is raw.
const paint_frame = lines => `\x1b[H${ lines.map( line => `${ line }\x1b[K` ).join( `\r\n` ) }\x1b[J`

/**
 * Wake on session registry writes (start, close, archive, rename): the list
 * changes the moment babysit records it instead of on the next tick.
 * @param {Function} on_change - Called on any change
 * @returns {Function} Stops watching
 */
const watch_registry = on_change => {
    try {
        const watcher = watch( SESSIONS_DIR, on_change )
        watcher.on( `error`, () => watcher.close() )
        return () => watcher.close()
    } catch ( error ) {
        log.debug( `watch: session registry not watched: ${ error.message }` )
        return () => {}
    }
}

/**
 * Live dashboard. Views:
 * - default: the session tree with a USAGE headroom column; idle-rule sessions
 *   show hh:mm to their next turn as status, config:/on: flags only with `--all`
 * - `--usage`: the account usage panel alone
 * - `--all`: both
 * Frames sample every pane once per second (track_session_activity) and also
 * redraw the moment the session registry changes. A frame is written only when
 * it differs from the one on screen, in place on the alternate screen.
 * Sessions sort by last opened, so numbers move when that changes. Ones idle over
 * 24h (nothing unread) drop into a condensed list below the tree.
 * `--interactive`: ↑/↓ select a session (the selection follows it across
 * re-sorts), enter opens it, space marks an unread one read, e moves it to the idle list,
 * i toggles task titles (the agent's own terminal title, saved on the session),
 * f freezes/unfreezes it, r restarts it (rr unless idle), ? lists the shortcuts; typing its number
 * opens it too. Detaching (or the session closing) comes back here. Under the shell-init wrapper babysit exits instead
 * and the wrapper attaches, then runs `babysit watch --interactive` again.
 * Usage refreshes every 5 min in the background so frames never wait on providers.
 * The Docker build cache is measured hourly, also in the background, and an
 * oversized one adds a warning line that points at `babysit prune`.
 * Codex's app-server fallback stays off: it can rotate tokens outside the auth lease.
 * Ctrl+C or q leaves a cleared terminal behind.
 * @param {Object} [cmd] - Parsed command; `notice` is a line shown until the first key (the post-attach hint)
 * @param {Object} [deps]
 * @param {Function} [deps.collect_fn] - Usage collector seam
 * @param {Function} [deps.disk_health_fn] - Background storage check, resolves to its health record
 * @param {Function} [deps.disk_read_fn] - Last cached storage health, read once at start
 * @param {Object} [deps.disk_seams] - statfs/stat seams for live free space
 * @param {Function} [deps.accounts_fn] - Registered Claude account names, as one comparable string
 * @param {Function} [deps.render_sessions_fn] - Session tree renderer
 * @param {Function} [deps.observe_activity_fn] - Pane activity observer, kept across frames
 * @param {Function|null} [deps.wait_fn] - Delay between frames; null waits until the next tick or change
 * @param {Function} [deps.write_fn] - Raw terminal writer
 * @param {Function} [deps.now_fn] - Clock seam
 * @param {Function} [deps.watch_fn] - Registry change listener, returns a stop function
 * @param {Object} [deps.input] - Keyboard stream
 * @param {Object} [deps.output] - Terminal stream, for TTY and resize detection
 * @param {Function} [deps.open_fn] - Session opener
 * @param {Function} [deps.mark_read_fn] - Clears a session's unread stamp, by tmux name
 * @param {Function} [deps.shelve_fn] - Moves a session to the idle list, by tmux name
 * @param {Function} [deps.save_title_fn] - Saves a session's task title on its record, by babysit id
 * @param {Function} [deps.run_fn] - Runs a babysit command in the background (freeze, restart), resolves { ok, out }
 * @param {Function} [deps.attach_count_fn] - In-process attach counter
 * @param {number} [deps.rounds] - Frame count; endless by default
 */
export const cmd_watch = async ( { flags = {}, notice: first_notice = null } = {}, {
    collect_fn = collect_account_usage,
    disk_health_fn = refresh_disk_health,
    disk_read_fn = read_disk_health,
    disk_seams = undefined,
    accounts_fn = () => list_claude_accounts().map( ( { name } ) => name ).join( `,` ),
    render_sessions_fn = render_active_sessions,
    observe_activity_fn = track_session_activity(),
    wait_fn = null,
    write_fn = text => process.stdout.write( text ),
    now_fn = Date.now,
    watch_fn = watch_registry,
    input = process.stdin,
    output = process.stdout,
    open_fn = cmd_open,
    mark_read_fn = mark_read,
    shelve_fn = shelve_session,
    run_fn = run_babysit,
    save_title_fn = ( id, title ) => update_session( id, { title } ),
    attach_count_fn = foreground_attach_count,
    rounds = Infinity,
} = {} ) => {

    let report = null
    let error = null
    let refreshed_at = -Infinity
    let pending = null
    let accounts_seen = null
    let round = 0
    let disk_health = disk_read_fn()
    let disk_asked_at = -Infinity
    let disk_pending = null
    let pressured = new Set()

    // Refresh on the 5-min cadence, or at once when Claude accounts are added
    // or removed: the old report has no row for a new account's sessions
    const refresh_usage = () => {
        const accounts = accounts_fn()
        const stale = now_fn() - refreshed_at >= USAGE_REFRESH_MS || accounts !== accounts_seen
        if( pending || !stale ) return
        accounts_seen = accounts
        refreshed_at = now_fn()
        pending = Promise.resolve()
            .then( () => collect_fn( { codex_read: async () => null } ) )
            .then( fresh => {
                report = fresh
                error = null
            } )
            .catch( failure => {
                error = failure.message
                log.debug( `watch usage refresh failed: ${ failure.message }` )
            } )
            .finally( () => pending = null )
    }

    // Never awaited by a frame: the check can wait minutes on a busy daemon
    const refresh_disk = () => {
        if( disk_pending || now_fn() - disk_asked_at < DISK_HEALTH_POLL_MS ) return
        disk_asked_at = now_fn()
        disk_pending = Promise.resolve()
            .then( () => disk_health_fn() )
            .then( health => disk_health = health || disk_health )
            .catch( failure => log.debug( `watch disk check failed: ${ failure.message }` ) )
            .finally( () => disk_pending = null )
    }

    const show_sessions = !flags.usage || flags.all
    const show_panel = flags.usage || flags.all
    const interactive = Boolean( flags.interactive ) && show_sessions
    // Kept across attaches: it is a view preference
    let show_titles = false
    const saving = new Set()
    const keyboard = Boolean( input?.isTTY )
    const screen = Boolean( output?.isTTY )

    /**
     * One dashboard run, until Ctrl+C or a chosen session.
     * @returns {Promise<string|null>} The chosen session's babysit id (or tmux name), or null to quit
     */
    const dashboard = async ( opening_notice = null ) => {

        let body = []
        let shown = null
        let typed = ``
        let chosen = null
        let stopped = false
        let quit = false
        let chord = null
        let tick = null
        let wake = () => {}
        let targets = new Map()
        // Display-order rows and the one under the cursor, tracked by id so a re-sort cannot move it
        let rows = []
        let selected = null
        let help = false
        // One-line result or prompt above the footer; `armed` is the session awaiting a second r
        let notice = opening_notice ? paint( opening_notice, `dim` ) : ``
        let armed = null
        let notice_timer = null
        // The opening notice stays until a key press; results time out instead
        let sticky = Boolean( opening_notice )

        const footer = () => interactive
            ? help
                ? `any key to go back`
                : `↑↓ select · enter open · ? shortcuts · or type a number · ctrl+c to close${ typed ? `: ${ typed }…` : `` }`
            : `Live; Ctrl+C to stop.`

        // With titles on, each titled row gets a dim line under it. `highlight` keys on
        // the line's index in `body`, so the added lines carry no index of their own.
        const titled = lines => {
            if( !show_titles ) return lines.map( ( line, index ) => ( { line, index } ) )
            const title_after = new Map( rows.filter( row => row.title ).map( row => [ row.line, row.title ] ) )
            return lines.flatMap( ( line, index ) => [
                { line, index },
                ...title_after.has( index ) ? [ { line: paint( `        ↳ ${ title_after.get( index ) }`, `dim` ), index: -1 } ] : [],
            ] )
        }

        // The cursor replaces the two-space gutter every table and list line starts with
        const highlight = ( line, index ) => interactive && rows.some( row => row.target === selected && row.line === index ) && line.startsWith( `  ` )
            ? `${ paint( `›`, `blue` ) } ${ line.slice( 2 ) }`
            : line

        // Writes only what changed on screen; key presses repaint just the footer and cursor
        const show = () => {
            const lines = help ? HELP : [ ...titled( body ).map( ( { line, index } ) => highlight( line, index ) ), ...notice ? [ notice ] : [] ]
            const frame = paint_frame( [ ...lines, paint( footer(), `dim` ) ] )
            if( frame !== shown ) write_fn( frame )
            shown = frame
        }

        // Cancelling always wins: it clears a selection queued behind a slow
        // frame, and no later selection overrides it
        const stop = session_id => {
            clearTimeout( chord )
            if( session_id === undefined ) {
                chosen = null
                quit = true
            } else if( !stopped ) chosen = session_id
            stopped = true
            wake()
        }

        const move = step => {
            const at = rows.findIndex( row => row.target === selected )
            selected = rows[ Math.min( rows.length - 1, Math.max( 0, at + step ) ) ]?.target ?? selected
            typed = ``
            show()
        }

        // Marks the selected unread session read; the next frame drops its dot
        const read_selected = () => {
            const row = rows.find( row => row.target === selected )
            if( !row?.unread ) return
            row.unread = false
            Promise.resolve( mark_read_fn( row.tmux_name ) ).then( () => wake() )
        }

        // Late results never draw over an attach or the restored terminal
        const tell = ( text, ms = NOTICE_MS ) => {
            if( stopped ) return
            clearTimeout( notice_timer )
            notice = text
            if( text && ms ) notice_timer = setTimeout( () => tell( `` ), ms )
            show()
        }

        // Runs babysit in the background and reports back; the next frame shows the new state
        const background = ( row, args, { doing, done } ) => {
            tell( `${ doing } ${ row.name }…`, 0 )
            run_fn( args ).then( ( { ok, out } ) => {
                tell( ok ? done( out ) : paint( `${ row.name }: ${ out || `failed` }`, `red` ) )
                wake()
            } )
        }

        const freeze_selected = () => {
            const row = rows.find( row => row.target === selected )
            if( !row ) return
            const frozen = row.status === `frozen`
            background( row, [ frozen ? `unfreeze` : `freeze`, row.target ], {
                doing: frozen ? `unfreezing` : `freezing`,
                done: out => out || `${ frozen ? `unfroze` : `froze` } ${ row.name }`,
            } )
        }

        // An idle session restarts at once; anything else (mid-turn work would be
        // cut off) needs the key twice, and the restart is then forced
        const restart_selected = was_armed => {
            const row = rows.find( row => row.target === selected )
            if( !row ) return
            const idle = row.status === `idle`
            if( !idle && was_armed !== row.target ) {
                armed = row.target
                clearTimeout( notice_timer )
                notice_timer = setTimeout( () => {
                    armed = null
                    tell( `` )
                }, ARM_MS )
                notice = paint( `${ row.name } is ${ row.status }: press r again to restart`, `yellow` )
                return show()
            }
            background( row, [ `restart`, row.target, `--detach`, ...idle ? [] : [ `--force` ] ], {
                doing: `restarting`,
                done: () => `restarted ${ row.name }`,
            } )
        }

        // Shelves the selected session; it lands in the idle list on the next frame
        const shelve_selected = () => {
            const row = rows.find( row => row.target === selected )
            if( row ) Promise.resolve( shelve_fn( row.tmux_name ) ).then( () => wake() )
        }

        const choose = number => targets.has( number ) ? stop( targets.get( number ) ) : ( typed = ``, show() )

        // Digits pick a session as soon as no longer number could still follow;
        // with 1 and 12 on screen, `1` waits CHORD_MS for a second digit
        const on_key = key => {

            if( key === `\x03` || key === `q` ) return stop()
            if( stopped || !interactive ) return

            clearTimeout( chord )
            if( sticky ) {
                sticky = false
                tell( `` )
            }
            if( help ) {
                help = false
                return show()
            }

            // Any key but a second r calls off the restart prompt
            const was_armed = armed
            armed = null
            if( was_armed && key !== `r` ) tell( `` )

            if( key === `?` ) {
                help = true
                return show()
            }
            if( key === `f` ) return freeze_selected()
            if( key === `r` ) return restart_selected( was_armed )
            if( key === `up` || key === `down` ) return move( key === `up` ? -1 : 1 )
            if( key === ` ` ) return read_selected()
            if( key === `e` ) return shelve_selected()
            if( key === `i` ) {
                show_titles = !show_titles
                return show()
            }
            if( key === `\r` ) return typed ? choose( Number( typed ) ) : selected === null ? undefined : stop( selected )
            if( key === `\x7f` || key === `\x1b` ) {
                typed = ``
                return show()
            }
            if( !/^\d$/.test( key ) ) return

            typed += key
            const numbers = [ ...targets.keys() ]
            const exact = targets.has( Number( typed ) )
            const longer = numbers.some( number => String( number ).length > typed.length && String( number ).startsWith( typed ) )
            if( exact && !longer ) return choose( Number( typed ) )
            if( !longer ) typed = ``
            else chord = setTimeout( () => choose( Number( typed ) ), CHORD_MS )
            show()

        }

        // Redraw early on registry changes and resizes; bursts settle first
        // Pastes and buffered SSH input arrive as one chunk: one key at a time.
        // Escape sequences (Delete is ESC[3~, Page Up ESC[5~) go first, so
        // their digits never pick a session; a lone ESC still clears the input.
        // Even splits are typed text, odd ones the sequences between it.
        const on_data = data => data.toString().split( ESCAPE_SEQUENCE )
            .flatMap( ( part, index ) => index % 2 ? [ ARROWS[ part ] ].filter( Boolean ) : [ ...part ] )
            .forEach( on_key )

        let settle = null
        const nudge = () => {
            clearTimeout( settle )
            settle = setTimeout( () => wake(), SETTLE_MS )
        }
        const resize = () => {
            shown = null
            nudge()
        }

        const stop_watching = watch_fn( nudge )
        const on_signal = () => stop()
        // Signals still restore the terminal through the finally below
        SIGNALS.forEach( signal => process.on( signal, on_signal ) )
        output?.on?.( `resize`, resize )
        if( keyboard ) {
            input.setRawMode( true )
            input.on( `data`, on_data )
            input.resume()
        }
        if( screen ) write_fn( `\x1b[?1049h\x1b[?25l` )

        const pause = () => new Promise( resolve => {
            tick = setTimeout( resolve, FRAME_MS )
            wake = () => {
                clearTimeout( tick )
                resolve()
            }
        } )

        try {

            while( !stopped && round < rounds ) {

                round++
                refresh_usage()
                refresh_disk()

                const frame = await collect_lines( async () => {
                    const rendered = show_sessions ? await render_sessions_fn( {
                        hide_archived: true,
                        open_hint: false,
                        // Launch-yaml rules are noise on a dashboard; the countdown says what they do
                        rule_flags: Boolean( flags.all ),
                        countdowns: true,
                        recent_first: true,
                        idle_section: true,
                        observe_activity_fn,
                        // Read at print time, so a refresh that lands mid-sample still shows
                        extra_columns: [ { header: `USAGE`, cell: session => usage_cell( report, session ) } ],
                    } ) : null
                    if( show_panel ) format_usage_panel( report, { now: now_fn(), error } ).forEach( line => console.log( line ) )
                    const { lines: warnings, pressured: now_pressured } = disk_warnings( disk_health, { pressured, seams: disk_seams } )
                    pressured = now_pressured
                    warnings.forEach( line => console.log( paint( `⚠ ${ line }`, `yellow` ) ) )
                    return rendered
                } )

                // A half-typed number must not resolve against a list that changed under it
                const next_targets = frame.result?.targets || new Map()
                if( JSON.stringify( [ ...next_targets ] ) !== JSON.stringify( [ ...targets ] ) ) {
                    clearTimeout( chord )
                    typed = ``
                }
                targets = next_targets

                // The cursor stays on its session; if that is gone, on the same position
                const next_rows = frame.result?.rows || []
                if( !next_rows.some( row => row.target === selected ) ) {
                    const at = Math.max( 0, rows.findIndex( row => row.target === selected ) )
                    selected = next_rows[ Math.min( at, next_rows.length - 1 ) ]?.target ?? null
                }
                rows = next_rows

                // Keep the agent's latest title on the record, so it outlives the pane
                next_rows.filter( row => row.fresh_title && !saving.has( row.target ) ).forEach( row => {
                    saving.add( row.target )
                    Promise.resolve( save_title_fn( row.target, row.title ) )
                        .catch( failure => log.debug( `watch title save failed: ${ failure.message }` ) )
                        .finally( () => saving.delete( row.target ) )
                } )
                body = frame.lines
                if( !stopped ) show()

                if( !stopped && round < rounds ) await ( wait_fn ? wait_fn( FRAME_MS ) : pause() )

            }

        } finally {

            clearTimeout( chord )
            clearTimeout( settle )
            clearTimeout( tick )
            clearTimeout( notice_timer )
            stop_watching()
            SIGNALS.forEach( signal => process.off( signal, on_signal ) )
            output?.off?.( `resize`, resize )
            if( keyboard ) {
                input.off( `data`, on_data )
                input.setRawMode( false )
                input.pause()
            }
            // Quitting (Ctrl+C, q, a signal) also wipes the main screen: the
            // shell gets a clean prompt, not the scrollback watch came from.
            // Opening a session leaves it alone; the attach repaints anyway.
            if( screen ) write_fn( `\x1b[?25h\x1b[?1049l${ quit ? `\x1b[H\x1b[2J` : `` }` )

        }

        return chosen

    }

    let opening_notice = first_notice
    while( true ) {

        const session_id = await dashboard( opening_notice )
        opening_notice = null
        if( session_id === null ) break

        // A blocking attach comes back here on detach or close. Under the
        // shell-init wrapper nothing attached yet: babysit exits so the shell can.
        const attaches = attach_count_fn()
        await open_fn( { session_id, flags: {} } )
        if( attach_count_fn() === attaches || round >= rounds ) break

    }

    // A usage refresh still in flight is not awaited: quitting, or handing the
    // attach to the wrapper, must not wait on providers (index.js exits after watch)

}

/**
 * After an in-process attach ends (ctrl+b d, or the session closing), land on
 * the interactive watch list. Terminals only: scripts and tests get their
 * shell back.
 * @param {Object} [options]
 * @param {Function} [options.watch_fn] - Watch runner seam
 * @param {boolean} [options.terminal] - Whether stdin and stdout are TTYs
 * @returns {Promise<boolean>} Whether the watch list ran
 */
export const watch_after_detach = async ( {
    watch_fn = cmd_watch,
    terminal = watch_follows(),
} = {} ) => {

    if( !terminal || !foreground_attach_count() ) {
        // A hint held for a watch that is not coming still reaches the user
        const held = take_exit_notice()
        if( held ) console.log( `\n${ held }\n` )
        return false
    }
    await watch_fn( { flags: { interactive: true }, notice: take_exit_notice() } )
    return true

}
