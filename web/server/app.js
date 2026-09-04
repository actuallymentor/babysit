import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, extname, resolve, sep } from 'node:path'
import { log } from 'mentie'
import { AccessStore, cookie_value, LoginLimiter, SessionStore } from './auth.js'
import { BridgeStore } from './bridge.js'

const COOKIE_NAME = `babysit_web_session`
const JSON_CONTENT_TYPE = `application/json; charset=utf-8`
const MIME_TYPES = {
    '.css': `text/css; charset=utf-8`,
    '.html': `text/html; charset=utf-8`,
    '.js': `text/javascript; charset=utf-8`,
    '.json': JSON_CONTENT_TYPE,
    '.png': `image/png`,
    '.svg': `image/svg+xml`,
    '.webmanifest': `application/manifest+json`,
    '.woff2': `font/woff2`,
}
const MUTABLE_STATIC_FILES = new Set( [ `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png` ] )

const security_headers = {
    'Content-Security-Policy': `default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'`,
    'Cross-Origin-Opener-Policy': `same-origin`,
    'Referrer-Policy': `no-referrer`,
    'X-Content-Type-Options': `nosniff`,
    'X-Frame-Options': `DENY`,
}

const json = ( response, status_code, body, headers={} ) => {
    response.writeHead( status_code, {
        ...security_headers,
        'Cache-Control': `no-store`,
        'Content-Type': JSON_CONTENT_TYPE,
        ...headers,
    } )
    response.end( JSON.stringify( body ) )
}

const text = ( response, status_code, body ) => {
    response.writeHead( status_code, { ...security_headers, 'Cache-Control': `no-store`, 'Content-Type': `text/plain; charset=utf-8` } )
    response.end( body )
}

const request_body = ( request, maximum_bytes=17_408 ) => new Promise( ( resolve_body, reject_body ) => {
    const chunks = []
    let bytes = 0

    request.on( `data`, chunk => {
        bytes += chunk.length
        if( bytes <= maximum_bytes ) chunks.push( chunk )
    } )
    request.on( `end`, () => {
        if( bytes > maximum_bytes ) return reject_body( Object.assign( new Error( `Request body is too large` ), { status_code: 413 } ) )

        try {
            resolve_body( JSON.parse( Buffer.concat( chunks ).toString( `utf8` ) || `{}` ) )
        } catch {
            reject_body( Object.assign( new Error( `Request body must be valid JSON` ), { status_code: 400 } ) )
        }
    } )
    request.on( `error`, reject_body )
} )

const forwarded_value = ( request, name ) => request.headers[ name ]?.split( `,` )[ 0 ]?.trim()

const request_origin = ( request, config ) => {
    if( config.public_origin ) return config.public_origin.origin

    const protocol = config.trust_proxy ? forwarded_value( request, `x-forwarded-proto` ) : null
    const host = config.trust_proxy ? forwarded_value( request, `x-forwarded-host` ) : null
    return `${ protocol || `http` }://${ host || request.headers.host }`
}

const valid_unsafe_origin = ( request, config ) => {
    const { origin } = request.headers
    if( !origin || origin !== request_origin( request, config ) ) return false

    if( !config.public_origin ) return true

    const host = config.trust_proxy ? forwarded_value( request, `x-forwarded-host` ) || request.headers.host : request.headers.host
    return host === config.public_origin.host
}

const secure_cookie = ( request, config ) => {
    if( config.allow_insecure_http ) return false
    if( config.public_origin?.protocol === `https:` ) return true
    if( config.trust_proxy && forwarded_value( request, `x-forwarded-proto` ) === `https` ) return true
    return process.env.NODE_ENV === `production`
}

const session_cookie = ( token, request, config ) => [
    `${ COOKIE_NAME }=${ encodeURIComponent( token ) }`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${ Math.floor( config.session_ttl_ms / 1_000 ) }`,
    secure_cookie( request, config ) ? `Secure` : null,
].filter( Boolean ).join( `; ` )

const clear_cookie = ( request, config ) => [
    `${ COOKIE_NAME }=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=0`,
    secure_cookie( request, config ) ? `Secure` : null,
].filter( Boolean ).join( `; ` )

const authenticated_session = ( request, sessions, access ) => {
    const token = cookie_value( request.headers.cookie, COOKIE_NAME )
    const session = sessions.get( token )
    if( !session ) return null

    if( session.access_id !== access.current_access_id() ) {
        sessions.delete( token )
        return null
    }

    return session
}

const static_path = ( pathname, static_dir ) => {
    const requested_path = pathname === `/` ? `index.html` : decodeURIComponent( pathname.slice( 1 ) )
    const path = resolve( static_dir, requested_path )
    return path.startsWith( `${ static_dir }${ sep }` ) ? path : null
}

const serve_static = ( request, response, pathname, config ) => {
    const requested_path = static_path( pathname, config.static_dir )
    const asset_path = requested_path && existsSync( requested_path ) && statSync( requested_path ).isFile()
        ? requested_path
        : resolve( config.static_dir, `index.html` )

    if( !existsSync( asset_path ) ) return text( response, 404, `Not found` )

    const extension = extname( asset_path )
    const is_html = extension === `.html`
    const is_mutable = MUTABLE_STATIC_FILES.has( basename( asset_path ) )
    response.writeHead( 200, {
        ...security_headers,
        'Cache-Control': is_html ? `no-store` : is_mutable ? `no-cache` : `public, max-age=31536000, immutable`,
        'Content-Type': MIME_TYPES[ extension ] || `application/octet-stream`,
    } )
    if( request.method === `HEAD` ) return response.end()
    createReadStream( asset_path ).pipe( response )
}

const api_route = async ( request, response, pathname, stores, config ) => {
    const { access, bridge, limiter, sessions } = stores

    if( request.method === `POST` && !valid_unsafe_origin( request, config ) ) return json( response, 403, { error: `Origin is not allowed` } )

    if( request.method === `POST` && pathname === `/api/login` ) {
        if( !limiter.consume() ) return json( response, 429, { error: `Too many login attempts. Try again shortly.` } )

        const body = await request_body( request )
        const identity = access.authenticate( typeof body.token === `string` ? body.token : `` )
        if( !identity ) return json( response, 401, { error: `Invalid access key` } )

        const token = sessions.create( identity )
        return json( response, 200, { role: identity.role }, { 'Set-Cookie': session_cookie( token, request, config ) } )
    }

    const identity = authenticated_session( request, sessions, access )
    if( !identity ) return json( response, 401, { error: `Authentication required` } )

    if( request.method === `GET` && pathname === `/api/me` ) return json( response, 200, { role: identity.role } )

    if( request.method === `POST` && pathname === `/api/logout` ) {
        sessions.delete( cookie_value( request.headers.cookie, COOKIE_NAME ) )
        return json( response, 200, { ok: true }, { 'Set-Cookie': clear_cookie( request, config ) } )
    }

    if( request.method === `GET` && pathname === `/api/sessions` ) return json( response, 200, { sessions: bridge.summaries() } )

    const session_match = pathname.match( /^\/api\/sessions\/([A-Za-z0-9-]+)$/ )
    if( request.method === `GET` && session_match ) {
        const state = bridge.session( session_match[ 1 ] )
        if( !state ) return json( response, 404, { error: `Session is unavailable or stale` } )
        return json( response, 200, { pending: bridge.pending_for( state ), session: state } )
    }

    const message_match = pathname.match( /^\/api\/sessions\/([A-Za-z0-9-]+)\/messages$/ )
    if( request.method === `POST` && message_match ) {
        if( identity.role !== `write` ) return json( response, 403, { error: `This access key is read-only` } )

        const state = bridge.session( message_match[ 1 ] )
        if( !state ) return json( response, 404, { error: `Session is unavailable or stale` } )
        if( state.busy ) return json( response, 409, { error: `Session is busy` } )

        const body = await request_body( request )
        return json( response, 202, bridge.send( { screen_revision: body.screen_revision, session: state, text: body.text } ) )
    }

    return json( response, 404, { error: `Not found` } )
}

/**
 * Creates the production HTTP server with injectable configuration for tests.
 * @param {Object} config - Validated server configuration
 * @returns {import('node:http').Server} HTTP server
 */
export const create_app = config => {
    const stores = {
        access: new AccessStore( config.access_file ),
        bridge: new BridgeStore( config ),
        limiter: new LoginLimiter( { limit: config.login_limit, window_ms: config.login_window_ms } ),
        sessions: new SessionStore( config.session_ttl_ms ),
    }

    return createServer( async ( request, response ) => {
        try {
            const url = new URL( request.url, `http://localhost` )
            if( url.pathname === `/healthz` ) return text( response, 200, `ok\n` )
            if( url.pathname.startsWith( `/api/` ) ) return await api_route( request, response, url.pathname, stores, config )
            if( ![ `GET`, `HEAD` ].includes( request.method ) ) return text( response, 405, `Method not allowed` )
            return serve_static( request, response, url.pathname, config )
        } catch ( error ) {
            const status_code = error.status_code || 500
            if( status_code === 500 ) log.error( `Request failed:`, error )
            return json( response, status_code, { error: status_code === 500 ? `Internal server error` : error.message } )
        }
    } )
}
