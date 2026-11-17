import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

/** Exercises browser delivery against the integration fixture's real server and monitor. */
export async function drive_bridge_browser( { origin, token, session_id, message, verify_receipt } ) {
    const chrome_path = process.env.CHROME_PATH || [ `/usr/bin/google-chrome`, `/usr/bin/chromium` ].find( existsSync )
    if( !chrome_path ) throw new Error( `Set CHROME_PATH to run the browser test` )
    const browser = await puppeteer.launch( { executablePath: chrome_path, headless: true } )

    try {
        const page = await browser.newPage()
        const errors = []
        page.on( `pageerror`, error => errors.push( error.message ) )
        await page.setViewport( { deviceScaleFactor: 2, height: 844, isMobile: true, width: 390 } )
        await page.goto( origin, { waitUntil: `networkidle0` } )
        await page.type( `input[name="access-key"]`, token )
        await page.click( `button[type="submit"]` )
        const session_link = `a[href="/sessions/${ session_id }"]`
        await page.waitForSelector( session_link )
        assert.match( await page.$eval( `main`, element => element.textContent ), /1 live session/ )
        await page.click( session_link )
        await page.waitForSelector( `textarea[aria-label="Message"]` )
        await page.type( `textarea[aria-label="Message"]`, message )
        assert.equal( await page.$eval( `textarea`, element => element.value ), message )
        await page.waitForFunction( () => !document.querySelector( `button[type="submit"]` ).disabled )
        await page.click( `button[type="submit"]` )

        // Receipt comes from the actual terminal, never a fabricated bridge result.
        if( verify_receipt ) await verify_receipt( message )
        const preview = message.replace( /\s+/g, ` ` ).trim().slice( 0, 100 )
        await page.waitForFunction( expected => [ ...document.querySelectorAll( `[aria-label="Recent sends"] li` ) ].some( item =>
            item.querySelector( `p` )?.textContent === expected && item.querySelector( `strong` )?.textContent === `Delivered to agent`
        ), { timeout: 20_000 }, preview )
        assert.equal( await page.$eval( `textarea`, element => element.value ), `` )
        assert.deepEqual( errors, [] )
    } finally {
        await browser.close()
    }
}

/** Moves a live session to the idle list through its … menu, as a person would. */
export async function drive_bridge_menu( { origin, token, name } ) {
    const chrome_path = process.env.CHROME_PATH || [ `/usr/bin/google-chrome`, `/usr/bin/chromium` ].find( existsSync )
    if( !chrome_path ) throw new Error( `Set CHROME_PATH to run the browser test` )
    const browser = await puppeteer.launch( { executablePath: chrome_path, headless: true } )

    try {
        const page = await browser.newPage()
        const errors = []
        page.on( `pageerror`, error => errors.push( error.message ) )
        await page.setViewport( { deviceScaleFactor: 2, height: 844, isMobile: true, width: 390 } )
        await page.goto( origin, { waitUntil: `networkidle0` } )
        await page.type( `input[name="access-key"]`, token )
        await page.click( `button[type="submit"]` )

        const trigger = `[aria-label="Actions for ${ name }"]`
        await page.waitForSelector( trigger )
        await page.click( trigger )
        await page.waitForSelector( `[role="menu"]` )
        await page.$$eval( `[role="menuitem"]`, elements => elements.find( element => element.textContent === `Move to idle list` ).click() )

        // The host's own answer, relayed from the monitor's result
        await page.waitForFunction( expected => document.querySelector( `main` ).textContent.includes( expected ), { timeout: 20_000 }, `${ name }: Moved to the idle list` )
        assert.doesNotMatch( await page.$eval( `main`, element => element.textContent ), /Invalid request schema|older babysit/ )
        assert.deepEqual( errors, [] )
    } finally {
        await browser.close()
    }
}
