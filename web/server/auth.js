import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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

// Derive the signing key from the stored token hash: sessions then survive
// server restarts with no state to persist, and rotating the access token
// (`babysit web init`) changes the key, invalidating every session at once.
const session_key = access_id => createHmac( `sha256`, access_id ).update( `babysit-web-session-v1` ).digest()
const sign = ( payload, access_id ) => createHmac( `sha256`, session_key( access_id ) ).update( payload ).digest( `base64url` )

/** Issues stateless HMAC-signed browser sessions bound to the current access token. */
export class SessionStore {

    constructor( ttl_ms ) {
        this.ttl_ms = ttl_ms
        // Logged-out session families until their last cookie could expire.
        // In memory only: the server keeps no writable state. Logout also
        // clears the HttpOnly cookie, so the browser itself forgets it.
        this.revoked = new Map()
    }

    // A family is one login; renewals keep it, so logout revokes every
    // cookie descended from that login, not just the one presented.
    create( { access_id, family = randomBytes( 12 ).toString( `base64url` ), role } ) {
        const payload = Buffer.from( JSON.stringify( { expires_at: Date.now() + this.ttl_ms, family, role } ) ).toString( `base64url` )
        return `${ payload }.${ sign( payload, access_id ) }`
    }

    get( token, access_id ) {
        const [ payload, signature, extra ] = typeof token === `string` ? token.split( `.` ) : []
        if( !payload || !signature || extra !== undefined ) return null

        const expected = Buffer.from( sign( payload, access_id ) )
        const supplied = Buffer.from( signature )
        if( supplied.length !== expected.length || !timingSafeEqual( supplied, expected ) ) return null

        try {
            const session = JSON.parse( Buffer.from( payload, `base64url` ).toString( `utf8` ) )
            if( !Number.isFinite( session.expires_at ) || session.expires_at <= Date.now() ) return null
            if( `:${ session.role }` !== access_id.slice( access_id.lastIndexOf( `:` ) ) ) return null
            if( typeof session.family !== `string` || this.revoked.has( session.family ) ) return null
            return { access_id, expires_at: session.expires_at, family: session.family, role: session.role }
        } catch {
            return null
        }
    }

    /** Sessions past half their lifetime are reissued, so active use never expires. */
    needs_renewal( session ) {
        return session.expires_at - Date.now() < this.ttl_ms / 2
    }

    /** Revoke a verified session's whole family (see create). */
    delete( session ) {
        const now = Date.now()
        for( const [ family, expires_at ] of this.revoked ) if( expires_at <= now ) this.revoked.delete( family )
        this.revoked.set( session.family, now + this.ttl_ms )
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
