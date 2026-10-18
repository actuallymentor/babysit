/** Compact age: `just now`, `42s ago`, `3m ago`, `2h ago`; null when unparseable. */
export const age_label = ( timestamp, now=Date.now() ) => {
    const then = Date.parse( timestamp )
    if( !Number.isFinite( then ) ) return null

    const age = Math.max( 0, Math.floor( ( now - then ) / 1_000 ) )
    if( age < 5 ) return `just now`
    if( age < 60 ) return `${ age }s ago`
    if( age < 3_600 ) return `${ Math.floor( age / 60 ) }m ago`
    return `${ Math.floor( age / 3_600 ) }h ago`
}

/** Formats a bridge heartbeat age, never the age of the retained agent reply. */
export const heartbeat_label = ( updated_at, now=Date.now() ) => {
    const age = age_label( updated_at, now )
    return age ? `Last heartbeat ${ age }` : `Heartbeat unavailable`
}
