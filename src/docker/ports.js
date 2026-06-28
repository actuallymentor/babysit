const PORT_SYNTAX = `PORT or HOSTPORT:CONTAINERPORT`

const assert_port_number = ( value, original ) => {

    if( !/^\d+$/.test( value ) ) {
        throw new Error( `Invalid --port "${ original }": expected ${ PORT_SYNTAX }` )
    }

    const port = Number( value )
    if( port < 1 || port > 65_535 ) {
        throw new Error( `Invalid --port "${ original }": ports must be between 1 and 65535` )
    }

}

/**
 * Normalise a Babysit --port value into Docker publish syntax.
 * @param {string|number} value - CLI value, either PORT or HOSTPORT:CONTAINERPORT
 * @returns {string} Docker publish value as HOSTPORT:CONTAINERPORT
 */
export const normalise_port_mapping = ( value ) => {

    const raw = String( value ?? `` ).trim()
    if( !raw ) throw new Error( `--port requires a value: use --port 3000 or --port 3000:3000` )

    const parts = raw.split( `:` )

    if( parts.length === 1 ) {
        const [ port ] = parts
        assert_port_number( port, raw )
        return `${ port }:${ port }`
    }

    if( parts.length === 2 ) {
        const [ host_port, container_port ] = parts
        assert_port_number( host_port, raw )
        assert_port_number( container_port, raw )
        return `${ host_port }:${ container_port }`
    }

    throw new Error( `Invalid --port "${ raw }": expected ${ PORT_SYNTAX }` )

}

/**
 * Normalise one or more Babysit --port values into Docker publish syntax.
 * @param {string|string[]|number|number[]|undefined|null|false} values
 * @returns {string[]} Docker publish values as HOSTPORT:CONTAINERPORT
 */
export const normalise_port_mappings = ( values = [] ) => {

    if( values === undefined || values === null || values === false ) return []

    const list = Array.isArray( values ) ? values : [ values ]
    return list.map( normalise_port_mapping )

}
