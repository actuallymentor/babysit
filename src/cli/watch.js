import { setTimeout as delay } from 'node:timers/promises'

import { collect_usage } from '../docker/assets/usage/command.mjs'
import { relative_time, usage_color } from '../docker/assets/usage/format.mjs'
import { paint } from '../utils/color.js'
import { log } from '../utils/log.js'
import { render_active_sessions } from './list.js'

const FRAME_MS = 2_000
export const USAGE_REFRESH_MS = 5 * 60_000
const BAR_CELLS = 10

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
 * Ten-cell meter colored like `babysit usage`: calm, warning, red.
 * @param {number} percent - Used share, 0–100
 * @returns {string}
 */
export const usage_bar = percent => {

    const filled = Math.round( Math.min( 100, Math.max( 0, percent ) ) / 100 * BAR_CELLS )
    return paint( `▰`.repeat( filled ), usage_color( percent ) ) + paint( `▱`.repeat( BAR_CELLS - filled ), `dim` )

}

/**
 * One aligned row per limit, agent named on its first row only.
 * Signed-out agents fold into one dim line; problems keep a short reason.
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
    const signed_out = []

    report.agents.forEach( result => {

        // OpenCode spans providers; the others map one agent to one account.
        const label = safe_text( result.agent === `opencode` && result.provider ? `opencode/${ result.provider }` : result.agent )
        const first_row = rows.length

        if( result.status === `unauthenticated` ) return signed_out.push( label )
        if( result.status !== `ok` ) {
            const status = paint( result.status, result.status === `error` ? `red` : `yellow` )
            return notes.push( `${ label } ${ status } ${ paint( safe_text( result.message ), `dim` ) }` )
        }

        result.limits.forEach( limit => {

            const unit = limit.unit ? ` ${ safe_text( limit.unit ) }` : ``
            const percent = is_number( limit.used_percent ) ? limit.used_percent
                : is_number( limit.remaining_percent ) ? 100 - limit.remaining_percent
                    : null
            const amount = given( limit.used )
                ? `${ decimals( limit.used ) }${ given( limit.limit ) ? ` / ${ decimals( limit.limit ) }` : `` }${ unit }`
                : given( limit.remaining ) ? `${ decimals( limit.remaining ) }${ unit } left`
                    : limit.unlimited ? `unlimited` : ``

            // A limit with nothing to show is noise on a dashboard.
            if( percent === null && !amount ) return

            // Metered rows lead with the reset; amount-only rows make the amount the headline.
            const reset = limit.resets_at ? relative_time( limit.resets_at, now ) : null
            const tail = [
                reset && paint( `↻ ${ reset.replace( /^in /, `` ) }`, `dim` ),
                amount && paint( amount, percent === null ? null : `dim` ),
            ].filter( Boolean ).join( `  ` )

            rows.push( [
                rows.length === first_row ? label : ``,
                short_limit_name( safe_text( limit.name ), result.agent ),
                percent === null ? `` : usage_bar( percent ),
                percent === null ? `` : paint( `${ Math.round( percent ) }%`.padStart( 4 ), usage_color( percent ) ),
                tail,
            ] )

        } )

    } )

    const widths = rows[0]?.map( ( _, column ) => Math.max( ...rows.map( row => visible_length( row[ column ] ) ) ) ) || []
    const lines = rows.map( row => `  ${ row.map( ( cell, column ) => pad( cell, widths[ column ] ) ).join( `  ` ).trimEnd() }` )

    return [
        title,
        ...lines,
        ...notes.map( note => `  ${ note }` ),
        ...signed_out.length ? [ paint( `  signed out: ${ signed_out.join( `, ` ) }`, `dim` ) ] : [],
        ...failure,
    ]

}

/**
 * Live dashboard: the session tree plus account usage, redrawn every 2s.
 * Usage refreshes every 5 min in the background so frames never wait on providers.
 * Codex's app-server fallback stays off: it can rotate tokens outside the auth lease.
 * @param {Object} [cmd] - Parsed command
 * @param {Object} [deps]
 * @param {Function} [deps.collect_fn] - Usage collector seam
 * @param {Function} [deps.render_sessions_fn] - Session tree renderer
 * @param {Function} [deps.wait_fn] - Delay between redraws
 * @param {Function} [deps.write_fn] - Raw terminal writer
 * @param {Function} [deps.now_fn] - Clock seam
 * @param {number} [deps.rounds] - Redraw count; endless by default
 */
export const cmd_watch = async ( { flags = {} } = {}, {
    collect_fn = collect_usage,
    render_sessions_fn = render_active_sessions,
    wait_fn = delay,
    write_fn = text => process.stdout.write( text ),
    now_fn = Date.now,
    rounds = Infinity,
} = {} ) => {

    let report = null
    let error = null
    let refreshed_at = -Infinity
    let pending = null

    const refresh_usage = () => {
        if( pending || now_fn() - refreshed_at < USAGE_REFRESH_MS ) return
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

    // Redraw in place on the real terminal so every color survives; clearing
    // right before printing keeps the old frame up while panes are sampled.
    for( let round = 0; round < rounds; round++ ) {
        refresh_usage()
        await render_sessions_fn( {
            all: flags.all,
            hide_archived: true,
            before_print: () => write_fn( `\x1b[H\x1b[J` ),
        } )
        format_usage_panel( report, { now: now_fn(), error } ).forEach( line => console.log( line ) )
        console.log( paint( `\nRefreshing every 2s; Ctrl+C to stop.`, `dim` ) )
        await wait_fn( FRAME_MS )
    }

    await pending

}
