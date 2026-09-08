/** Formats a bridge heartbeat age, never the age of the retained agent reply. */
export const heartbeat_label = ( updated_at, now=Date.now() ) => {
    const heartbeat = Date.parse( updated_at )
    if( !Number.isFinite( heartbeat ) ) return `Heartbeat unavailable`

    const age = Math.max( 0, Math.floor( ( now - heartbeat ) / 1_000 ) )
    if( age < 5 ) return `Last heartbeat just now`
    if( age < 60 ) return `Last heartbeat ${ age }s ago`
    if( age < 3_600 ) return `Last heartbeat ${ Math.floor( age / 60 ) }m ago`
    return `Last heartbeat ${ Math.floor( age / 3_600 ) }h ago`
}
