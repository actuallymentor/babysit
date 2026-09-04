import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { create_app } from '../server/app.js'

const access_document = ( token, role=`write` ) => JSON.stringify( {
    protocol: 1,
    role,
    token_sha256: createHash( `sha256` ).update( token ).digest( `hex` ),
} )

const session_document = ( overrides={} ) => ( {
    activity: `idle`,
    agent: `codex`,
    attachment: `detached`,
    busy: false,
    directory: `~/project`,
    epoch: `epoch-1`,
    last_message: `## Finished\n\n- one\n- two`,
    modifiers: [ `yolo` ],
    name: `ship-feature`,
    protocol: 1,
    raw_screen: `raw pane`,
    results: [],
    revision: 7,
    session_id: `session-1`,
    updated_at: new Date().toISOString(),
    ...overrides,
} )

const api_request = async ( origin, path, { body, cookie, method=`GET`, request_headers={}, request_origin=origin }={} ) => {
    const headers = { ...request_headers }
    if( body ) headers[ `Content-Type` ] = `application/json`
    if( cookie ) headers.Cookie = cookie
    if( method === `POST` ) headers.Origin = request_origin

    const response = await fetch( `${ origin }${ path }`, { body: body && JSON.stringify( body ), headers, method } )
    const response_body = await response.json()
    return { body: response_body, cookie: response.headers.get( `set-cookie` )?.split( `;` )[ 0 ], headers: response.headers, status: response.status }
}

test( `authenticated bridge API`, async () => {
    const fixture = mkdtempSync( join( tmpdir(), `babysit-web-api-` ) )
    const state_dir = join( fixture, `state` )
    const request_dir = join( fixture, `requests` )
    const access_file = join( fixture, `access.json` )
    mkdirSync( state_dir )
    mkdirSync( request_dir )
    writeFileSync( access_file, access_document( `correct horse` ) )
    writeFileSync( join( state_dir, `session-1.json` ), JSON.stringify( session_document() ) )
    writeFileSync( join( state_dir, `stale.json` ), JSON.stringify( session_document( { epoch: `epoch-stale`, session_id: `stale` } ) ) )
    utimesSync( join( state_dir, `stale.json` ), new Date( 0 ), new Date( 0 ) )
    const orphan_request = join( request_dir, `old-session--old-epoch--123e4567-e89b-42d3-a456-426614174000.json` )
    const orphan_temporary = join( request_dir, `.babysit-web-123e4567-e89b-42d3-a456-426614174000.tmp` )
    writeFileSync( orphan_request, `{}` )
    writeFileSync( orphan_temporary, `{}` )
    writeFileSync( join( request_dir, `host-owned.txt` ), `keep` )
    utimesSync( orphan_request, new Date( 0 ), new Date( 0 ) )
    utimesSync( orphan_temporary, new Date( 0 ), new Date( 0 ) )

    const server = create_app( {
        access_file,
        allow_insecure_http: true,
        heartbeat_ttl_ms: 5_000,
        login_limit: 1,
        login_window_ms: 60_000,
        public_origin: null,
        request_dir,
        request_ttl_ms: 500,
        session_ttl_ms: 60_000,
        state_dir,
        static_dir: join( fixture, `static` ),
        trust_proxy: true,
    } )
    await new Promise( resolve_listen => server.listen( 0, `127.0.0.1`, resolve_listen ) )
    const origin = `http://127.0.0.1:${ server.address().port }`

    try {
        const anonymous = await api_request( origin, `/api/sessions` )
        assert.equal( anonymous.status, 401 )

        const foreign_origin = await api_request( origin, `/api/login`, { body: { token: `correct horse` }, method: `POST`, request_origin: `https://attacker.example` } )
        assert.equal( foreign_origin.status, 403 )

        const wrong_login = await api_request( origin, `/api/login`, {
            body: { token: `wrong` },
            method: `POST`,
            request_headers: { 'X-Forwarded-For': `198.51.100.1` },
        } )
        assert.equal( wrong_login.status, 401 )

        const limited_login = await api_request( origin, `/api/login`, {
            body: { token: `correct horse` },
            method: `POST`,
            request_headers: { 'X-Forwarded-For': `198.51.100.1` },
        } )
        assert.equal( limited_login.status, 429 )

        const login = await api_request( origin, `/api/login`, {
            body: { token: `correct horse` },
            method: `POST`,
            request_headers: { 'X-Forwarded-For': `198.51.100.2` },
        } )
        assert.equal( login.status, 200 )
        assert.equal( login.body.role, `write` )
        assert.match( login.headers.get( `set-cookie` ), /HttpOnly; SameSite=Strict/ )
        assert.doesNotMatch( login.headers.get( `set-cookie` ), /Secure/ )

        const list = await api_request( origin, `/api/sessions`, { cookie: login.cookie } )
        assert.equal( list.status, 200 )
        assert.equal( list.body.sessions.length, 1 )
        assert.equal( list.body.sessions[ 0 ].session_id, `session-1` )
        assert.equal( `last_message` in list.body.sessions[ 0 ], false )
        assert.match( list.headers.get( `content-security-policy` ), /frame-ancestors 'none'/ )
        assert.equal( list.headers.get( `cache-control` ), `no-store` )

        const detail = await api_request( origin, `/api/sessions/session-1`, { cookie: login.cookie } )
        assert.equal( detail.body.session.last_message, `## Finished\n\n- one\n- two` )

        writeFileSync( join( state_dir, `session-1.json` ), JSON.stringify( session_document( { busy: true } ) ) )
        const busy_send = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `Wait for the action` },
            cookie: login.cookie,
            method: `POST`,
        } )
        assert.equal( busy_send.status, 409 )
        writeFileSync( join( state_dir, `session-1.json` ), JSON.stringify( session_document() ) )

        const sent = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `Continue\ncarefully` },
            cookie: login.cookie,
            method: `POST`,
        } )
        assert.equal( sent.status, 202 )
        const request_filename = readdirSync( request_dir ).find( filename => filename.startsWith( `session-1--` ) )
        assert.match( request_filename, /^session-1--epoch-1--[a-f0-9-]+\.json$/ )
        assert.deepEqual( JSON.parse( readFileSync( join( request_dir, request_filename ), `utf8` ) ), {
            epoch: `epoch-1`,
            kind: `text`,
            protocol: 1,
            request_id: sent.body.request_id,
            session_id: `session-1`,
            text: `Continue\ncarefully`,
        } )
        unlinkSync( join( request_dir, request_filename ) )

        const unsupported = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `hide\u202esecret` },
            cookie: login.cookie,
            method: `POST`,
        } )
        assert.equal( unsupported.status, 400 )

        const expiring = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `Time out this request` },
            cookie: login.cookie,
            method: `POST`,
        } )
        assert.equal( expiring.status, 202 )
        await new Promise( resolve_wait => setTimeout( resolve_wait, 1_100 ) )
        assert.deepEqual( readdirSync( request_dir ), [ `host-owned.txt` ] )

        const queue_files = Array.from( { length: 63 }, ( _, index ) => join( request_dir, `queue-${ index }.tmp` ) )
        queue_files.forEach( path => writeFileSync( path, `{}` ) )
        const queue_full = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `One too many` },
            cookie: login.cookie,
            method: `POST`,
        } )
        assert.equal( queue_full.status, 429 )
        queue_files.forEach( path => unlinkSync( path ) )

        const replacement = `${ access_file }.new`
        writeFileSync( replacement, access_document( `viewer key`, `read` ) )
        renameSync( replacement, access_file )

        const revoked = await api_request( origin, `/api/me`, { cookie: login.cookie } )
        assert.equal( revoked.status, 401 )

        const read_login = await api_request( origin, `/api/login`, {
            body: { token: `viewer key` },
            method: `POST`,
            request_headers: { 'X-Forwarded-For': `198.51.100.3` },
        } )
        const read_send = await api_request( origin, `/api/sessions/session-1/messages`, {
            body: { text: `Should fail` },
            cookie: read_login.cookie,
            method: `POST`,
        } )
        assert.equal( read_send.status, 403 )
    } finally {
        await new Promise( resolve_close => server.close( resolve_close ) )
        rmSync( fixture, { force: true, recursive: true } )
    }
} )

test( `production proxy and HTTP cookie policy`, async () => {
    const fixture = mkdtempSync( join( tmpdir(), `babysit-web-proxy-` ) )
    const state_dir = join( fixture, `state` )
    const request_dir = join( fixture, `requests` )
    const access_file = join( fixture, `access.json` )
    mkdirSync( state_dir )
    mkdirSync( request_dir )
    writeFileSync( access_file, access_document( `proxy key` ) )

    const server = create_app( {
        access_file,
        allow_insecure_http: false,
        heartbeat_ttl_ms: 5_000,
        login_limit: 8,
        login_window_ms: 60_000,
        public_origin: null,
        request_dir,
        request_ttl_ms: 20_000,
        session_ttl_ms: 60_000,
        state_dir,
        static_dir: join( fixture, `static` ),
        trust_proxy: true,
    } )
    await new Promise( resolve_listen => server.listen( 0, `127.0.0.1`, resolve_listen ) )
    const origin = `http://127.0.0.1:${ server.address().port }`

    try {
        const plain_http = await api_request( origin, `/api/login`, { body: { token: `proxy key` }, method: `POST` } )
        assert.equal( plain_http.status, 400 )
        assert.match( plain_http.body.error, /HTTPS is required/ )

        const proxied_https = await api_request( origin, `/api/login`, {
            body: { token: `proxy key` },
            method: `POST`,
            request_headers: {
                'X-Forwarded-For': `198.51.100.4`,
                'X-Forwarded-Host': `babysit.example.com`,
                'X-Forwarded-Proto': `https`,
            },
            request_origin: `https://babysit.example.com`,
        } )
        assert.equal( proxied_https.status, 200 )
        assert.match( proxied_https.headers.get( `set-cookie` ), /Secure/ )
    } finally {
        await new Promise( resolve_close => server.close( resolve_close ) )
        rmSync( fixture, { force: true, recursive: true } )
    }
} )
