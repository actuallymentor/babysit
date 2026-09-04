import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import puppeteer from 'puppeteer-core'
import { create_app } from '../server/app.js'

const chrome_path = process.env.CHROME_PATH || [ `/usr/bin/google-chrome`, `/usr/bin/chromium` ].find( path => {
    try {
        readFileSync( path )
        return true
    } catch {
        return false
    }
} )

if( !chrome_path ) throw new Error( `Set CHROME_PATH to run the browser test` )

const fixture = mkdtempSync( join( tmpdir(), `babysit-web-browser-` ) )
const state_dir = join( fixture, `state` )
const request_dir = join( fixture, `requests` )
const access_file = join( fixture, `access.json` )
const state_file = join( state_dir, `mobile-session.json` )
mkdirSync( state_dir )
mkdirSync( request_dir )
writeFileSync( access_file, JSON.stringify( {
    protocol: 1,
    role: `write`,
    token_sha256: createHash( `sha256` ).update( `mobile-secret` ).digest( `hex` ),
} ) )
writeFileSync( state_file, JSON.stringify( {
    activity: `idle`,
    agent: `codex`,
    attachment: `detached`,
    busy: false,
    directory: `~/babysit`,
    epoch: `browser-epoch`,
    last_message: `## Ready\n\n- Built the bridge\n- Tested the app\n\n\`npm test\`\n\n![blocked](https://example.com/private.png)\n\n<script>window.evil = true</script>`,
    modifiers: [ `yolo` ],
    name: `Mobile release`,
    protocol: 1,
    raw_screen: `raw fallback`,
    results: [],
    revision: 3,
    session_id: `mobile-session`,
    updated_at: new Date().toISOString(),
} ) )

const server = create_app( {
    access_file,
    allow_insecure_http: true,
    heartbeat_ttl_ms: 30_000,
    login_limit: 20,
    login_window_ms: 60_000,
    public_origin: null,
    request_dir,
    request_ttl_ms: 20_000,
    session_ttl_ms: 60_000,
    state_dir,
    static_dir: resolve( `dist` ),
    trust_proxy: false,
} )

await new Promise( resolve_listen => server.listen( 0, `127.0.0.1`, resolve_listen ) )
const origin = `http://127.0.0.1:${ server.address().port }`
const browser = await puppeteer.launch( { executablePath: chrome_path, headless: true } )

try {
    const page = await browser.newPage()
    await page.setViewport( { deviceScaleFactor: 2, height: 844, isMobile: true, width: 390 } )
    await page.goto( origin, { waitUntil: `networkidle0` } )

    await page.type( `input[name="access-key"]`, `mobile-secret` )
    await Promise.all( [ page.waitForSelector( `a[href="/sessions/mobile-session"]` ), page.click( `button[type="submit"]` ) ] )
    assert.match( await page.$eval( `main`, element => element.textContent ), /Mobile release/ )
    assert.match( await page.$eval( `main`, element => element.textContent ), /yolo/ )

    await Promise.all( [ page.waitForSelector( `[data-testid="markdown-message"]` ), page.click( `a[href="/sessions/mobile-session"]` ) ] )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] h2`, element => element.textContent ), `Ready` )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] li`, elements => elements.length ), 2 )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] img`, elements => elements.length ), 0 )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] script`, elements => elements.length ), 0 )
    assert.equal( await page.evaluate( () => window.evil ), undefined )

    await page.type( `textarea[aria-label="Message"]`, `Ship it from mobile` )
    await page.click( `button[type="submit"]` )
    await page.waitForFunction( () => document.body.textContent.includes( `Message: pending` ) )

    const [ request_filename ] = readdirSync( request_dir )
    const request = JSON.parse( readFileSync( join( request_dir, request_filename ), `utf8` ) )
    assert.equal( request.text, `Ship it from mobile` )
    assert.equal( request.session_id, `mobile-session` )
    unlinkSync( join( request_dir, request_filename ) )

    await page.goto( `${ origin }/sessions/mobile-session`, { waitUntil: `networkidle0` } )
    assert.equal( await page.$eval( `h1`, element => element.textContent ), `Mobile release` )

    const manifest = await page.evaluate( async () => fetch( document.querySelector( `link[rel="manifest"]` ).href ).then( response => response.json() ) )
    assert.deepEqual( manifest.icons.map( icon => icon.sizes ), [ `192x192`, `512x512` ] )
    const icon_type = await page.evaluate( async () => fetch( `/icon-192.png` ).then( response => response.headers.get( `content-type` ) ) )
    assert.equal( icon_type, `image/png` )
    const worker_cache = await page.evaluate( async () => fetch( `/sw.js` ).then( response => response.headers.get( `cache-control` ) ) )
    assert.equal( worker_cache, `no-cache` )
    assert.equal( await page.evaluate( async () => Boolean( await navigator.serviceWorker.ready ) ), true )

    await page.click( `button[title="Clear the app cache and reload"]` )
} finally {
    await browser.close()
    await new Promise( resolve_close => server.close( resolve_close ) )
    rmSync( fixture, { force: true, recursive: true } )
}
