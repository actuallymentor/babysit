const MIB = 1024 ** 2
const GIB = 1024 ** 3
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Whole MiB, or GiB with one decimal from 1 GiB up. */
export const format_memory = bytes => bytes >= GIB
    ? `${ ( bytes / GIB ).toFixed( 1 ) } GiB`
    : `${ Math.round( bytes / MIB ) } MiB`

/** One decimal under 10%, whole numbers above. */
export const format_percent = percent => `${ percent < 10 ? percent.toFixed( 1 ) : Math.round( percent ) }%`

/** Calm below half, warning below 70%, critical above; mirrors `babysit list`. */
export const load_level = ratio => ratio < 0.5 ? `calm` : ratio < 0.7 ? `warning` : `critical`

/** Compact CPU · MEM line for one container sample. */
export const container_label = container => container
    ? [ container.cpu_percent !== null && `${ format_percent( container.cpu_percent ) } CPU`, format_memory( container.memory_bytes ) ].filter( Boolean ).join( ` · ` )
    : `Container usage pending`

/** Time until a reset as the two largest units: `2d 4h`, `3h 12m`, `45m`. */
export const reset_label = ( resets_at, now=Date.now() ) => {
    const ms = Date.parse( resets_at ) - now
    if( !Number.isFinite( ms ) ) return null
    if( ms < MINUTE ) return `Resets now`

    const days = Math.floor( ms / DAY )
    const hours = Math.floor( ms % DAY / HOUR )
    const minutes = Math.floor( ms % HOUR / MINUTE )
    const parts = days ? [ `${ days }d`, hours && `${ hours }h` ] : hours ? [ `${ hours }h`, minutes && `${ minutes }m` ] : [ `${ minutes }m` ]
    return `Resets in ${ parts.filter( Boolean ).join( ` ` ) }`
}

/** Percent used, derived from remaining or numeric amounts (OpenRouter budgets) when not reported. */
export const used_percent = limit => {
    if( limit.used_percent !== null ) return limit.used_percent
    if( limit.remaining_percent !== null ) return 100 - limit.remaining_percent
    const used = Number( limit.used )
    const cap = Number( limit.limit )
    return limit.used !== null && limit.limit !== null && Number.isFinite( used ) && cap > 0 ? used / cap * 100 : null
}

/** Secondary amount text such as `12 / 50 credits`. */
export const amount_label = limit => {
    const unit = limit.unit ? ` ${ limit.unit }` : ``
    if( limit.unlimited ) return `No ${ limit.unit === `USD` ? `spending cap` : `limit` }`
    if( limit.used !== null ) return `${ limit.used }${ limit.limit !== null ? ` / ${ limit.limit }` : `` }${ unit }`
    if( limit.remaining !== null ) return `${ limit.remaining }${ unit } left`
    return null
}

/**
 * Humane limit names: `five_hour` → `5-hour`, `codex / 10080 min` → `7-day`.
 * The agent prefix is dropped since the group already names it.
 * @param {string} name - Provider limit name
 * @param {string} agent - Agent the limit belongs to
 * @returns {string}
 */
export const limit_name = ( name, agent ) => {

    const text = String( name )
        .replace( new RegExp( `^${ agent } / ` ), `` )
        .replace( /^API key \/ /, `` )
        .replace( /(\d+) min\b/, ( _, minutes ) => {
            const hours = minutes / 60
            return hours >= 24 && hours % 24 === 0 ? `${ hours / 24 }-day` : hours >= 1 ? `${ hours }-hour` : `${ minutes }-minute`
        } )
        .replace( /^five_hour|^session$/, `5-hour` )
        .replace( /^seven_day_?|^weekly_all$|^weekly_scoped(?: \/ )?/, `7-day ` )
        .replace( /_/g, ` ` )
        .trim()

    return text.charAt( 0 ).toUpperCase() + text.slice( 1 )

}
