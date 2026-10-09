// Human rendering of a usage report. Self-contained: this file ships into the
// image as a bare directory, so it cannot reach src/utils/color.js.

const CODES = { dim: `2;38;5;242`, green: `32`, yellow: `33`, red: `31` }
const color_enabled = ( { env = process.env, stream = process.stdout } = {} ) => {
    if( env.FORCE_COLOR && env.FORCE_COLOR !== `0` ) return true
    if( env.NO_COLOR || env.TERM === `dumb` ) return false
    return Boolean( stream?.isTTY )
}
const paint = ( text, color, options ) => color && color_enabled( options ) ? `\x1b[${ CODES[ color ] }m${ text }\x1b[0m` : String( text )

const safe_text = value => String( value ).replace( /[\x00-\x1f\x7f-\x9f]/g, `` )
// Providers send money and credits as long decimals; two places is what humans read.
const trim_decimals = text => /^-?\d+\.\d{3,}$/.test( text ) ? Number( text ).toFixed( 2 ).replace( /\.?0+$/, `` ) : text
const amount = value => value === null || value === undefined ? null : trim_decimals( safe_text( value ) )
const is_number = value => typeof value === `number` && Number.isFinite( value )

/** Calm below half, warning below 70%, red above; mirrors `babysit list` load colors. */
export const usage_color = used_percent => used_percent < 50 ? `green` : used_percent < 70 ? `yellow` : `red`

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTHS = [ `Jan`, `Feb`, `Mar`, `Apr`, `May`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec` ]
const two_digits = value => String( value ).padStart( 2, `0` )

/**
 * Time until a reset as the two largest units: `in 2d 4h`, `in 3h 12m`, `in 45m`.
 * Past or present resets read `now`.
 */
export const relative_time = ( target, now ) => {

    const ms = new Date( target ).getTime() - new Date( now ).getTime()
    if( !Number.isFinite( ms ) ) return null
    if( ms < MINUTE ) return `now`

    const days = Math.floor( ms / DAY )
    const hours = Math.floor( ms % DAY / HOUR )
    const minutes = Math.floor( ms % HOUR / MINUTE )
    const parts = days ? [ `${ days }d`, hours && `${ hours }h` ] : hours ? [ `${ hours }h`, minutes && `${ minutes }m` ] : [ `${ minutes }m` ]
    return `in ${ parts.filter( Boolean ).join( ` ` ) }`

}

/** Local-time `Oct 11 16:00`; invalid dates fall back to the raw text. */
const absolute_time = value => {

    const date = new Date( value )
    if( Number.isNaN( date.getTime() ) ) return safe_text( value )
    return `${ MONTHS[ date.getMonth() ] } ${ date.getDate() } ${ two_digits( date.getHours() ) }:${ two_digits( date.getMinutes() ) }`

}

const join_cells = ( cells, options ) => cells.map( cell => paint( cell?.text ?? cell, cell?.color, options ) ).join( ` · ` )

/** One table row per limit; cells are plain text or { text, color }. */
const limit_row = ( limit, now, options ) => {

    const unit = limit.unit || ``

    const used = []
    if( is_number( limit.used_percent ) ) used.push( { text: `${ limit.used_percent }%`, color: usage_color( limit.used_percent ) } )
    if( amount( limit.used ) !== null ) used.push( `${ amount( limit.used ) }${ amount( limit.limit ) !== null ? ` / ${ amount( limit.limit ) }` : `` } ${ unit }`.trim() )
    else if( amount( limit.limit ) !== null ) used.push( `limit ${ amount( limit.limit ) } ${ unit }`.trim() )

    const remaining = []
    if( is_number( limit.remaining_percent ) ) remaining.push( { text: `${ limit.remaining_percent }%`, color: usage_color( 100 - limit.remaining_percent ) } )
    if( amount( limit.remaining ) !== null ) remaining.push( `${ amount( limit.remaining ) } ${ unit }`.trim() )
    if( limit.unlimited ) remaining.push( `no ${ unit === `USD` ? `spending cap` : `limit` }` )

    const relative = limit.resets_at ? relative_time( limit.resets_at, now ) : null
    const resets = relative
        ? `${ relative } ${ paint( absolute_time( limit.resets_at ), `dim`, options ) }`
        : limit.resets_at ? safe_text( limit.resets_at ) : ``

    const cells = [ safe_text( limit.name ), join_cells( used, options ), join_cells( remaining, options ), resets ]
    return cells.some( ( cell, index ) => index && cell ) ? cells : [ cells[0], { text: `not reported`, color: `dim` } ]

}

const visible_length = text => text.replace( /\x1b\[[\d;]*m/g, `` ).length
const pad = ( cell, width, options ) => {
    const text = paint( cell?.text ?? cell, cell?.color, options )
    return text + ` `.repeat( Math.max( 0, width - visible_length( text ) ) )
}

/**
 * Indented table with a dim header. Columns nobody fills are dropped, and
 * widths follow visible text, not ANSI codes.
 */
const table = ( header, rows, options ) => {

    const columns = header.map( ( _, column ) => column ).filter( column => rows.some( row => row[ column ] ) )
    const all = [ header.map( text => ( { text, color: `dim` } ) ), ...rows ].map( row => columns.map( column => row[ column ] ?? `` ) )
    const widths = columns.map( ( _, column ) => Math.max( ...all.map( row => visible_length( String( row[ column ]?.text ?? row[ column ] ) ) ) ) )
    return all.map( row => `  ${ row.map( ( cell, column ) => pad( cell, widths[ column ], options ) ).join( `  ` ).trimEnd() }` )

}

const STATUS_COLORS = { error: `red`, unavailable: `yellow`, unauthenticated: `dim` }

/** Render native windows/units without presenting missing information as zero. */
export const format_usage = ( report, options = {} ) => report.agents.map( result => {

    const title = `${ result.agent }${ result.provider ? ` / ${ safe_text( result.provider ) }` : `` }`
    if( result.status !== `ok` ) return `${ title }: ${ paint( result.status, STATUS_COLORS[ result.status ], options ) } — ${ safe_text( result.message ) }`
    if( !result.limits.length ) return `${ title }\n  ${ paint( `no limits reported`, `dim`, options ) }`

    const now = result.fetched_at || report.fetched_at || new Date().toISOString()
    const rows = result.limits.map( limit => limit_row( limit, now, options ) )
    return [ title, ...table( [ `limit`, `used`, `remaining`, `resets` ], rows, options ) ].join( `\n` )

} ).join( `\n\n` )
