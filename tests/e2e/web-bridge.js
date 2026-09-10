import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// Isolate both the real CLI and imported production monitor from user sessions.
const root = mkdtempSync( join( tmpdir(), `babysit-web-roundtrip-` ) )
const socket = `babysit-web-test-${ process.pid }`
const repository = resolve( fileURLToPath( new URL( `../../`, import.meta.url ) ) )
const bridge_dir = join( root, `bridge` )
process.env.BABYSIT_HOME = join( root, `.babysit` )
process.env.BABYSIT_TMUX_SOCKET = socket
process.env.BABYSIT_WEB_BRIDGE_DIR = bridge_dir
const run = promisify( execFile )
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const cli = args => run( process.execPath, [ join( repository, `src/index.js` ), ...args ], {
    env: { ...process.env, HOME: root }, timeout: 15_000,
} )
const until = async ( description, check ) => {
    const deadline = Date.now() + 15_000
    while( Date.now() < deadline ) {
        if( await check() ) return
        await delay( 100 )
    }
    throw new Error( `Timed out: ${ description }` )
}
const { start_monitor } = await import( `../../src/babysit/monitor.js` )
const { open_web_bridge } = await import( `../../src/web_bridge/bridge.js` )
const { create_app } = await import( `../../web/server/app.js` )
const session = {
    babysit_id: `roundtrip-session`, name: `Bridge roundtrip`, agent: `codex`,
    tmux_session: `babysit_roundtrip`, pwd: root, modifiers: [], started_at: new Date().toISOString(),
}
let monitor
let server
let cookie = ``
let origin
let busy = false
const request = async ( path, body ) => fetch( `${ origin }/api/${ path }`, {
    method: body === undefined ? `GET` : `POST`,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': `application/json` },
    body: body === undefined ? undefined : JSON.stringify( body ),
} )

try {
    // This terminal fixture enables the same bracketed paste mode as agent TUIs.
    // Record only submitted messages, so a swallowed Enter cannot falsely pass.
    const receipt = join( root, `received.jsonl` )
    const terminal = join( root, `terminal.mjs` )
    writeFileSync( terminal, `
import { appendFileSync } from 'node:fs'
process.stdin.setRawMode(true)
process.stdout.write('\\x1b[?2004hReady\\r\\n')
let buffer = ''
process.stdin.on('data', data => {
    buffer += data.toString()
    const end = buffer.indexOf('\\x1b[201~\\r')
    if (end < 0) return
    const message = buffer.slice(buffer.indexOf('\\x1b[200~') + 6, end)
    appendFileSync(process.argv[2], JSON.stringify(message) + '\\n')
    process.stdout.write('Received: ' + message + '\\r\\n')
    buffer = buffer.slice(end + 7)
})
` )
    await tmux( [ `new-session`, `-d`, `-s`, session.tmux_session, process.execPath, terminal, receipt ] )
    session.pane_id = ( await tmux( [ `display-message`, `-p`, `-t`, session.tmux_session, `#{pane_id}` ] ) ).stdout.trim()
    mkdirSync( join( root, `.babysit/sessions` ), { recursive: true } )
    writeFileSync( join( root, `.babysit/sessions`, `${ session.babysit_id }.json` ), JSON.stringify( session ) )
    await until( `terminal ready`, async () => ( await tmux( [ `capture-pane`, `-p`, `-t`, session.tmux_session ] ) ).stdout.includes( `Ready` ) )

    monitor = start_monitor( {
        session_name: session.tmux_session, tmux_target: session.pane_id, config: {}, rules: [], agent_patterns: {},
        agent: { name: `codex` }, input_allowed: () => !busy,
        open_web_bridge_fn: () => open_web_bridge( { session } ),
        write_loop_deadline_fn: () => null,
    } )
    await delay( 1_200 )
    // Selecting a split pane must never redirect web input away from the agent.
    await tmux( [ `split-window`, `-t`, session.tmux_session, `sleep`, `60` ] )
    const initialized = await cli( [ `web`, `init` ] )
    const token = initialized.stdout.match( /Access token \(shown once\): (\S+)/ )?.[1]
    assert.ok( token, `CLI prints the login capability` )
    assert.match( ( await cli( [ `list` ] ) ).stdout, /Bridge roundtrip/ )

    server = create_app( {
        access_file: join( bridge_dir, `access/access.json` ), state_dir: join( bridge_dir, `state` ),
        request_dir: join( bridge_dir, `requests` ), heartbeat_ttl_ms: 3_000, request_ttl_ms: 20_000,
        allow_insecure_http: true, login_limit: 20, login_window_ms: 60_000,
        public_origin: null, session_ttl_ms: 120_000, static_dir: join( repository, `web/dist` ), trust_proxy: false,
    } )
    await new Promise( resolve_listen => server.listen( 0, `127.0.0.1`, resolve_listen ) )
    origin = `http://127.0.0.1:${ server.address().port }`
    const login = await request( `login`, { token } )
    assert.equal( login.status, 200 )
    const [ session_cookie ] = login.headers.get( `set-cookie` ).split( `;` )
    cookie = session_cookie
    await until( `running session discovered after web init`, async () =>
        ( await ( await request( `sessions` ) ).json() ).sessions.length === 1
    )
    const messages = [ `Please continue`, `First line\nSecond line — Unicode ✓` ]
    for( const text of messages ) {
        const sent = await request( `sessions/${ session.babysit_id }/messages`, { text } )
        assert.equal( sent.status, 202 )
        const { request_id } = await sent.json()
        await until( `agent receives submitted message`, () => {
            try {
                return readFileSync( receipt, `utf8` ).split( `\n` ).filter( Boolean ).map( JSON.parse ).includes( text )
            } catch {
                return false
            }
        } )
        await until( `delivery acknowledged`, async () => {
            const detail = await ( await request( `sessions/${ session.babysit_id }` ) ).json()
            return detail.pending.some( item => item.request_id === request_id && item.status === `accepted` )
        } )
    }
    assert.deepEqual( readFileSync( receipt, `utf8` ).trim().split( `\n` ).map( JSON.parse ), messages )

    const { drive_bridge_browser } = await import( `../../web/test/bridge.browser.e2e.js` )
    await drive_bridge_browser( {
        origin, token, session_id: session.babysit_id,
        message: `Browser first line\nBrowser second line — Unicode ✓`,
        verify_receipt: text => until( `browser message reaches agent`, () =>
            readFileSync( receipt, `utf8` ).trim().split( `\n` ).map( JSON.parse ).includes( text )
        ),
    } )

    busy = true
    await until( `busy session remains visible`, async () => ( await ( await request( `sessions` ) ).json() ).sessions[0]?.busy )
    assert.equal( ( await request( `sessions/${ session.babysit_id }/messages`, { text: `blocked` } ) ).status, 409 )
    busy = false
    await delay( 3_500 )
    assert.equal( ( await ( await request( `sessions` ) ).json() ).sessions.length, 1, `monitor keeps heartbeat fresh` )
    await tmux( [ `kill-session`, `-t`, session.tmux_session ] )
    await monitor
    monitor = null
    assert.deepEqual( ( await ( await request( `sessions` ) ).json() ).sessions, [] )
    console.log( `PASS: CLI web init/list, late discovery, HTTP/browser→tmux single/multiline delivery, acknowledgements, busy rejection, heartbeat, exit cleanup` )
} finally {
    await tmux( [ `kill-server` ] ).catch( () => null )
    if( monitor ) await monitor
    if( server ) await new Promise( resolve_close => server.close( resolve_close ) )
    rmSync( root, { recursive: true, force: true } )
}
