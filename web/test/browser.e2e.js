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
    last_message: `## Ready\n\n- Built the bridge\n- Tested the app\n\n\`npm test\`\n\n\`\`\`js\nconst long_message = "${ `Readable code with horizontal scrolling. `.repeat( 8 ) }"\n\`\`\`\n\n${ `A completed reply stays readable while you prepare the next instruction. `.repeat( 35 ) }\n\n![blocked](https://example.com/private.png)\n\n<script>window.evil = true</script>`,
    modifiers: [ `yolo` ],
    name: `Mobile release`,
    protocol: 1,
    raw_screen: `Planning the change\nRunning tools\nAn earlier reply\nReady`,
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
    session_ttl_ms: 120_000,
    state_dir,
    static_dir: resolve( `dist` ),
    trust_proxy: false,
} )

await new Promise( resolve_listen => server.listen( 0, `127.0.0.1`, resolve_listen ) )
const origin = `http://127.0.0.1:${ server.address().port }`
const browser = await puppeteer.launch( { executablePath: chrome_path, headless: true } )

try {
    await browser.defaultBrowserContext().overridePermissions( origin, [ `clipboard-read`, `clipboard-sanitized-write` ] )
    const page = await browser.newPage()
    const browser_errors = []
    page.on( `pageerror`, error => browser_errors.push( error.message ) )
    await page.setViewport( { deviceScaleFactor: 2, height: 844, isMobile: true, width: 390 } )

    await page.goto( origin, { waitUntil: `networkidle0` } )

    await page.type( `input[name="access-key"]`, `mobile-secret` )
    await Promise.all( [ page.waitForSelector( `a[href="/sessions/mobile-session"]` ), page.click( `button[type="submit"]` ) ] )
    assert.match( await page.$eval( `main`, element => element.textContent ), /Mobile release/ )
    assert.match( await page.$eval( `main`, element => element.textContent ), /yolo/ )

    // Reading preferences follow the OS until explicitly overridden, then survive reloads.
    await page.emulateMediaFeatures( [ { name: `prefers-color-scheme`, value: `dark` } ] )
    const dark_background = await page.$eval( `html`, element => getComputedStyle( element ).backgroundColor )
    await page.click( `[aria-label="App menu"]` )
    await page.select( `[aria-label="Theme"]`, `light` )
    await page.waitForFunction( background => getComputedStyle( document.documentElement ).backgroundColor !== background, {}, dark_background )
    const light_background = await page.$eval( `html`, element => getComputedStyle( element ).backgroundColor )
    const original_size = await page.$eval( `html`, element => parseFloat( getComputedStyle( element ).fontSize ) )
    await page.click( `[aria-label="Increase text size"]` )
    assert.ok( await page.$eval( `html`, element => parseFloat( getComputedStyle( element ).fontSize ) ) > original_size )
    await page.reload( { waitUntil: `networkidle0` } )
    assert.equal( await page.$eval( `html`, element => getComputedStyle( element ).backgroundColor ), light_background )
    assert.ok( await page.$eval( `html`, element => parseFloat( getComputedStyle( element ).fontSize ) ) > original_size )
    await page.click( `[aria-label="App menu"]` )
    await page.select( `[aria-label="Theme"]`, `dark` )
    await page.waitForFunction( background => getComputedStyle( document.documentElement ).backgroundColor === background, {}, dark_background )
    if( process.env.AUDIT_SCREENSHOTS ) await page.screenshot( { path: `/tmp/babysit-ui-dark.png`, fullPage: false } )
    await page.select( `[aria-label="Theme"]`, `system` )
    await page.emulateMediaFeatures( [ { name: `prefers-color-scheme`, value: `light` } ] )
    await page.waitForFunction( background => getComputedStyle( document.documentElement ).backgroundColor === background, {}, light_background )
    await page.click( `[aria-label="Decrease text size"]` )
    await page.click( `[aria-label="App menu"]` )

    await Promise.all( [ page.waitForSelector( `[data-testid="markdown-message"]` ), page.click( `a[href="/sessions/mobile-session"]` ) ] )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] h2`, element => element.textContent ), `Ready` )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] li`, elements => elements.length ), 2 )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] img`, elements => elements.length ), 0 )
    assert.equal( await page.$$eval( `[data-testid="markdown-message"] script`, elements => elements.length ), 0 )
    assert.equal( await page.evaluate( () => window.evil ), undefined )
    assert.doesNotMatch( await page.$eval( `[aria-label="Latest message"]`, element => element.textContent ), /Planning the change|Running tools|An earlier reply/ )

    // Narrow screens, enlarged type, and user spacing overrides must preserve the page width.
    const assert_page_fits = async () => assert.equal( await page.evaluate( () => document.documentElement.scrollWidth <= innerWidth ), true )
    await assert_page_fits()
    await page.setViewport( { height: 900, width: 1440 } )
    await page.waitForSelector( `[data-testid="markdown-message"]` )
    if( process.env.AUDIT_SCREENSHOTS ) await page.screenshot( { path: `/tmp/babysit-ui-desktop.png`, fullPage: false } )
    await assert_page_fits()
    const desktop_font = await page.$eval( `body`, element => parseFloat( getComputedStyle( element ).fontSize ) )
    const prose_width = await page.$eval( `[data-testid="markdown-message"] p`, element => element.getBoundingClientRect().width )
    assert.ok( prose_width < 900, `Desktop prose should have a readable measure` )
    await page.setViewport( { height: 720, isMobile: true, width: 320 } )
    await page.waitForSelector( `[data-testid="markdown-message"]` )
    assert.ok( await page.$eval( `body`, element => parseFloat( getComputedStyle( element ).fontSize ) ) < desktop_font, `Flow text should adapt to viewport width` )
    await page.click( `[aria-label="App menu"]` )
    for( let step = 0; step < 5; step++ ) await page.click( `[aria-label="Increase text size"]` )
    await assert_page_fits()
    const spacing_override = await page.addStyleTag( { content: `* { letter-spacing: 0.12em !important; word-spacing: 0.16em !important; line-height: 1.5 !important; } p { margin-bottom: 2em !important; }` } )
    await assert_page_fits()
    await page.click( `[aria-label="App menu"]` )
    await assert_page_fits()
    await spacing_override.evaluate( element => element.remove() )
    await page.click( `[aria-label="App menu"]` )
    for( let step = 0; step < 5; step++ ) await page.click( `[aria-label="Decrease text size"]` )
    await page.click( `[aria-label="App menu"]` )
    await page.setViewport( { deviceScaleFactor: 2, height: 844, isMobile: true, width: 390 } )

    await page.waitForSelector( `[data-testid="markdown-message"]` )
    if( process.env.AUDIT_SCREENSHOTS ) await page.screenshot( { path: `/tmp/babysit-ui-mobile.png`, fullPage: false } )
    await page.bringToFront()
    if( process.env.AUDIT_SCREENSHOTS ) {
        await page.click( `[aria-label="App menu"]` )
        await page.select( `[aria-label="Theme"]`, `dark` )
        await page.click( `[aria-label="App menu"]` )
        await page.screenshot( { path: `/tmp/babysit-ui-session-dark.png` } )
        await page.click( `[aria-label="App menu"]` )
        await page.select( `[aria-label="Theme"]`, `system` )
        await page.click( `[aria-label="App menu"]` )
    }
    await page.click( `[aria-label="Copy code"]` )
    await page.waitForFunction( () => /Copied|Copy failed/.test( document.querySelector( `[data-testid="markdown-message"]` ).textContent ) )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] [role="status"]`, element => element.textContent ), `Copied` )
    assert.match( await page.evaluate( () => navigator.clipboard.readText() ), /^const long_message = / )
    await page.evaluate( () => window.scrollTo( 0, 0 ) )
    const reply_button = await page.waitForSelector( `::-p-text(Reply ↓)` )
    const reply_bounds = await reply_button.boundingBox()
    assert.ok( reply_bounds.y >= 0 && reply_bounds.y + reply_bounds.height <= 844, `Reply stays within the viewport` )
    await reply_button.click()
    assert.equal( await page.$eval( `textarea`, element => document.activeElement === element ), true )
    assert.ok( await page.$eval( `textarea`, element => element.getBoundingClientRect().top >= 0 && element.getBoundingClientRect().bottom <= innerHeight ) )
    assert.ok( await page.evaluate( () => Boolean( document.querySelector( `#reply` ).compareDocumentPosition( document.querySelector( `details` ) ) & Node.DOCUMENT_POSITION_FOLLOWING ) ) )
    assert.doesNotMatch( await page.$eval( `#reply`, element => element.textContent ), /16,384 bytes/ )

    assert.equal( await page.$eval( `details`, element => element.open ), false )
    await page.click( `summary` )
    assert.match( await page.$eval( `details pre`, element => element.innerText ), /Planning the change\nRunning tools\nAn earlier reply/ )
    await page.click( `summary` )

    const completed_state = JSON.parse( readFileSync( state_file, `utf8` ) )
    writeFileSync( state_file, JSON.stringify( { ...completed_state, activity: `active`, busy: true, raw_screen: `Working on the next turn` } ) )
    await page.waitForFunction( () => document.body.textContent.includes( `You can draft while sending is paused` ) )
    assert.equal( await page.$eval( `textarea`, element => element.disabled ), false )
    await page.type( `textarea[aria-label="Message"]`, `Draft while the agent works` )
    assert.equal( await page.$eval( `button[type="submit"]`, element => element.disabled ), true )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] h2`, element => element.textContent ), `Ready` )
    writeFileSync( state_file, JSON.stringify( { ...completed_state, last_message: `` } ) )
    await page.waitForFunction( () => document.body.textContent.includes( `No completed reply captured yet.` ) )
    assert.equal( await page.$( `[data-testid="markdown-message"]` ), null )
    assert.doesNotMatch( await page.$eval( `[aria-label="Latest message"]`, element => element.textContent ), /Planning the change|Running tools|An earlier reply/ )
    assert.equal( await page.$eval( `details`, element => element.open ), false )
    await page.click( `summary` )
    assert.match( await page.$eval( `details pre`, element => element.innerText ), /Planning the change/ )
    await page.click( `summary` )
    writeFileSync( state_file, JSON.stringify( completed_state ) )
    await page.waitForSelector( `[data-testid="markdown-message"]` )

    assert.equal( await page.$eval( `textarea`, element => element.value ), `Draft while the agent works` )
    await page.setOfflineMode( true )
    await page.waitForFunction( () => document.body.textContent.includes( `Connection interrupted` ) )
    assert.equal( await page.$eval( `textarea`, element => element.value ), `Draft while the agent works` )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] h2`, element => element.textContent ), `Ready` )
    assert.equal( await page.$eval( `button[type="submit"]`, element => element.disabled ), true )
    await page.setOfflineMode( false )
    await page.waitForFunction( () => !document.body.textContent.includes( `Connection interrupted` ) && !document.querySelector( `button[type="submit"]` )?.disabled )

    // A connected network can still stall: the request deadline must release polling for recovery.
    await page.emulateNetworkConditions( { download: -1, upload: -1, latency: 15_000 } )
    await page.waitForFunction( () => document.body.textContent.includes( `Connection interrupted` ), { timeout: 20_000 } )
    assert.equal( await page.$eval( `textarea`, element => element.value ), `Draft while the agent works` )
    assert.equal( await page.$eval( `[data-testid="markdown-message"] h2`, element => element.textContent ), `Ready` )
    assert.equal( await page.$eval( `button[type="submit"]`, element => element.disabled ), true )
    await page.emulateNetworkConditions( null )
    await page.waitForFunction( () => !document.body.textContent.includes( `Connection interrupted` ) && !document.querySelector( `button[type="submit"]` )?.disabled )

    await page.click( `textarea` )
    await page.keyboard.down( `Control` )
    await page.keyboard.press( `KeyA` )
    await page.keyboard.up( `Control` )
    await page.keyboard.press( `Backspace` )

    writeFileSync( state_file, JSON.stringify( { ...completed_state, updated_at: new Date().toISOString() } ) )
    await page.type( `textarea[aria-label="Message"]`, `Ship it from mobile` )
    await page.click( `button[type="submit"]` )
    await page.waitForFunction( () => document.querySelector( `[aria-label="Recent sends"]` )?.textContent.includes( `Queued` ) )
    assert.match( await page.$eval( `[aria-label="Recent sends"]`, element => element.textContent ), /Ship it from mobile/ )

    const [ request_filename ] = readdirSync( request_dir )
    const request = JSON.parse( readFileSync( join( request_dir, request_filename ), `utf8` ) )
    assert.equal( request.text, `Ship it from mobile` )
    assert.equal( request.session_id, `mobile-session` )
    unlinkSync( join( request_dir, request_filename ) )
    writeFileSync( state_file, JSON.stringify( {
        ...completed_state,
        results: [ { request_id: request.request_id, status: `accepted` } ],
        updated_at: new Date().toISOString(),
    } ) )
    await page.waitForFunction( () => document.querySelector( `[aria-label="Recent sends"]` )?.textContent.includes( `Delivered to agent` ) )
    assert.match( await page.$eval( `[aria-label="Recent sends"]`, element => element.textContent ), /Ship it from mobile/ )

    await page.goto( `${ origin }/sessions/mobile-session`, { waitUntil: `networkidle0` } )
    assert.equal( await page.$eval( `h1`, element => element.textContent ), `Mobile release` )

    const manifest = await page.evaluate( async () => fetch( document.querySelector( `link[rel="manifest"]` ).href ).then( response => response.json() ) )
    assert.deepEqual( manifest.icons.map( icon => icon.sizes ), [ `192x192`, `512x512` ] )
    assert.equal( await page.$eval( `link[rel="apple-touch-icon"]`, element => new URL( element.href ).pathname ), `/icon-192.png` )
    const icon_type = await page.evaluate( async () => fetch( `/icon-192.png` ).then( response => response.headers.get( `content-type` ) ) )
    assert.equal( icon_type, `image/png` )
    const worker_cache = await page.evaluate( async () => fetch( `/sw.js` ).then( response => response.headers.get( `cache-control` ) ) )
    assert.equal( worker_cache, `no-cache` )
    assert.equal( await page.evaluate( async () => Boolean( await navigator.serviceWorker.ready ) ), true )

    unlinkSync( state_file )
    await page.waitForFunction( () => document.body.textContent.includes( `It may have ended or missed its heartbeat` ) )
    assert.equal( await page.$( `textarea` ), null )
    writeFileSync( state_file, JSON.stringify( { ...completed_state, updated_at: new Date().toISOString() } ) )
    await page.goto( `${ origin }/sessions/mobile-session`, { waitUntil: `networkidle0` } )
    await page.waitForSelector( `textarea` )

    assert.deepEqual( browser_errors, [] )
    await page.click( `[aria-label="App menu"]` )
    await page.click( `button[title="Clear the app cache and reload"]` )
} finally {
    await browser.close()
    await new Promise( resolve_close => server.close( resolve_close ) )
    rmSync( fixture, { force: true, recursive: true } )
}
