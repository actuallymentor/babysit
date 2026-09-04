import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_LOGIN_CLIENTS = 1_024

const parse_access = raw_access => {
    const parsed = JSON.parse( raw_access )

    if( parsed.protocol !== 1 || !SHA256_PATTERN.test( parsed.token_sha256 ) || ![ `read`, `write` ].includes( parsed.role ) ) throw new Error( `Invalid Babysit Web access file` )

    return { role: parsed.role, token_sha256: parsed.token_sha256 }
}

/** Loads hash-only access configuration and notices atomic token rotation. */
export class AccessStore {

    constructor( access_file ) {
        this.access_file = access_file
        this.access = null
        this.reload()
    }

    reload() {
        this.access = parse_access( readFileSync( this.access_file, `utf8` ) )
        return this.access
    }

    authenticate( token ) {
        const { role, token_sha256 } = this.reload()
        const supplied_hash = createHash( `sha256` ).update( token ).digest()
        const expected_hash = Buffer.from( token_sha256, `hex` )

        return timingSafeEqual( supplied_hash, expected_hash ) ? { access_id: `${ token_sha256 }:${ role }`, role } : null
    }

    current_access_id() {
        const { role, token_sha256 } = this.reload()
        return `${ token_sha256 }:${ role }`
    }
}

/** Stores short-lived opaque browser sessions in memory. */
export class SessionStore {

    constructor( ttl_ms ) {
        this.ttl_ms = ttl_ms
        this.sessions = new Map()
    }

    create( { access_id, role } ) {
        const token = randomBytes( 32 ).toString( `base64url` )
        this.sessions.set( token, { access_id, expires_at: Date.now() + this.ttl_ms, role } )
        return token
    }

    get( token ) {
        const session = token && this.sessions.get( token )
        if( !session ) return null

        if( session.expires_at <= Date.now() ) {
            this.sessions.delete( token )
            return null
        }

        return session
    }

    delete( token ) {
        if( token ) this.sessions.delete( token )
    }
}

/** Applies one process-wide fixed-window login limit. */
export class LoginLimiter {

    constructor( { limit, window_ms } ) {
        this.limit = limit
        this.window_ms = window_ms
        this.attempts = new Map()
    }

    consume( key ) {
        const cutoff = Date.now() - this.window_ms
        const attempts = ( this.attempts.get( key ) || [] ).filter( timestamp => timestamp > cutoff )

        if( attempts.length >= this.limit ) return false

        if( !this.attempts.has( key ) && this.attempts.size >= MAX_LOGIN_CLIENTS ) {
            this.attempts.delete( this.attempts.keys().next().value )
        }
        attempts.push( Date.now() )
        this.attempts.set( key, attempts )
        return true
    }
}

/**
 * Extracts one cookie value without trusting malformed cookie pairs.
 * @param {string} cookie_header - Raw Cookie header
 * @param {string} name - Cookie name
 * @returns {string|null} Decoded cookie value
 */
export const cookie_value = ( cookie_header=``, name ) => {
    const pair = cookie_header.split( `;` ).map( value => value.trim() ).find( value => value.startsWith( `${ name }=` ) )
    if( !pair ) return null

    try {
        return decodeURIComponent( pair.slice( name.length + 1 ) )
    } catch {
        return null
    }
}
