/**
 * Parse a timeout string into seconds
 * Supports formats: SS, MM:SS, HH:MM:SS
 * @param {string|number} input - The timeout value
 * @returns {number} Timeout in seconds
 */
export const parse_timeout = ( input ) => {

    // Already a number
    if( typeof input === `number` ) return input

    const str = String( input ).trim()
    const parts = str.split( `:` )

    if( parts.length === 1 ) return parseInt( parts[0], 10 )

    if( parts.length === 2 ) {
        const [ minutes, seconds ] = parts.map( p => parseInt( p, 10 ) )
        return  minutes * 60  + seconds
    }

    if( parts.length === 3 ) {
        const [ hours, minutes, seconds ] = parts.map( p => parseInt( p, 10 ) )
        return  hours * 3600  +  minutes * 60  + seconds
    }

    return 300

}

/**
 * Format seconds into a human-readable countdown string
 * @param {number} seconds - Seconds remaining
 * @returns {string} Formatted as HH:MM:SS or MM:SS
 */
export const format_timeout = ( seconds ) => {

    const h = Math.floor( seconds / 3600 )
    const m = Math.floor(  seconds % 3600  / 60 )
    const s = seconds % 60

    const pad = n => String( n ).padStart( 2, `0` )

    if( h > 0 ) return `${ pad( h ) }:${ pad( m ) }:${ pad( s ) }`
    return `${ pad( m ) }:${ pad( s ) }`

}
