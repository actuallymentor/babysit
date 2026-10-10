#!/usr/bin/env node
/*
 * Re-login driver, run inside a throwaway babysit container under xvfb:
 *
 *   xvfb-run -a node /opt/relogin/driver.mjs --mode token|login --email you@example.com [--account you@example.com]
 *
 * 1. Starts `claude setup-token` (token mode) or `claude auth login` (login
 *    mode) in a private tmux pane with a temp CLAUDE_CONFIG_DIR. $BROWSER is a
 *    script that records the authorize URL, whose redirect is the CLI's own
 *    localhost listener, so no code is ever pasted.
 * 2. Opens that URL in a persistent Chrome profile. A live claude.ai session
 *    only needs "Authorize"; an expired one gets the email, then the login
 *    link from Gmail (mail.py), opened in the same profile. RELOGIN_SESSION_KEY
 *    seeds the profile with a pasted claude.ai `sessionKey` cookie first.
 *    A Cloudflare human check is never solved: the run stops and says so.
 *    With --account, a browser signed in as anyone else is never authorized.
 * 3. Prints one `RESULT {json}` line on stdout: { ok, token, account } or
 *    { ok, credentials, account }, else { ok: false, step, reason, run_dir }.
 *    `account` is the address the CLI recorded, when it recorded one.
 *    Progress goes to stderr.
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import puppeteer from 'puppeteer'

import { classify_page, in_hosts, snapshot_page } from './page_state.mjs'

const { values: args } = parseArgs( { options: {
    mode: { type: `string`, default: `token` },
    email: { type: `string`, default: `` },
    account: { type: `string`, default: `` },
    home: { type: `string`, default: `/home/node/relogin` },
    'timeout-ms': { type: `string`, default: String( 12 * 60_000 ) },
} } )

const TOKEN_PATTERN = /sk-ant-oat\d+-[\w-]+/
const TMUX = [ `-L`, `babysit-relogin` ]
const STUCK_MS = 60_000
const RUN_RETENTION_MS = 7 * 24 * 3600_000

const deadline = Date.now() + Number( args[ `timeout-ms` ] )
const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) )
const progress = line => process.stderr.write( `relogin: ${ line }\n` )
const redact = url => String( url ).replace( /[?#].*/, `` )

const profile_dir = join( args.home, `profile` )
const run_dir = join( args.home, `runs`, new Date().toISOString().replace( /[:.]/g, `-` ) )
const work = join( tmpdir(), `relogin-${ process.pid }` )

/* ---------------------------------------------------------------------------
 * The claude CLI in a private tmux pane
 * ------------------------------------------------------------------------- */

const start_cli = () => {

    const config_dir = join( work, `config` )
    const url_file = join( work, `authorize-url` )
    mkdirSync( config_dir, { recursive: true } )

    // The CLI "opens a browser" by handing us the URL
    writeFileSync( join( work, `browser.sh` ), `#!/bin/sh\nprintf '%s\\n' "$1" > '${ url_file }'\n`, { mode: 0o700 } )

    // Nothing may outrank the login being minted; the pane outlives the CLI
    // so its last screen (the token) stays readable
    const command = args.mode === `token` ? `claude setup-token` : `claude auth login --claudeai --email "$RELOGIN_EMAIL"`
    writeFileSync( join( work, `cli.sh` ), [
        `#!/bin/sh`,
        `unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_PROFILE CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY`,
        `export CLAUDE_CONFIG_DIR='${ config_dir }' BROWSER='${ join( work, `browser.sh` ) }'`,
        command,
        `echo "RELOGIN_CLI_EXIT=$?"`,
        `sleep 3600`,
    ].join( `\n` ), { mode: 0o700 } )

    execFileSync( `tmux`, [ ...TMUX, `new-session`, `-d`, `-s`, `relogin`, `-x`, `500`, `-y`, `80`, join( work, `cli.sh` ) ], {
        env: { ...process.env, RELOGIN_EMAIL: args.email },
    } )

    const pane = () => {
        try {
            return execFileSync( `tmux`, [ ...TMUX, `capture-pane`, `-p`, `-J`, `-S`, `-`, `-t`, `relogin` ], { encoding: `utf8` } )
        } catch {
            return ``
        }
    }

    return {

        authorize_url: () => existsSync( url_file ) ? readFileSync( url_file, `utf8` ).trim() : null,

        // { token } or { credentials } once the CLI has its login, { exit } if it gave up
        outcome: () => {
            const screen = pane()
            const account = () => {
                try {
                    return JSON.parse( readFileSync( join( config_dir, `.claude.json` ), `utf8` ) ).oauthAccount?.emailAddress || null
                } catch {
                    return null
                }
            }
            if( args.mode === `token` ) {
                const token = screen.match( TOKEN_PATTERN )?.[0]
                if( token ) return { token, account: account() }
            } else {
                const file = join( config_dir, `.credentials.json` )
                const credentials = existsSync( file ) && JSON.parse( readFileSync( file, `utf8` ) )
                if( credentials?.claudeAiOauth?.accessToken ) return { credentials, account: account() }
            }
            const exit = screen.match( /RELOGIN_CLI_EXIT=(\d+)/ )?.[1]
            return exit === undefined ? null : { exit: Number( exit ), screen: screen.trim().split( `\n` ).slice( -5 ).join( ` | ` ) }
        },

        stop: () => {
            try {
                execFileSync( `tmux`, [ ...TMUX, `kill-server` ], { stdio: `ignore` } )
            } catch {
                // already gone
            }
        },

    }

}

/* ---------------------------------------------------------------------------
 * Mail
 * ------------------------------------------------------------------------- */

const fetch_login_mail = since => new Promise( resolve => {

    const timeout = Math.max( 30, Math.floor( ( deadline - Date.now() ) / 1000 ) - 30 )
    const child = spawn( `python3`, [ `-I`, new URL( `./mail.py`, import.meta.url ).pathname, `--since`, String( since ), `--timeout`, String( timeout ) ], {
        stdio: [ `ignore`, `pipe`, `inherit` ],
    } )

    let output = ``
    child.stdout.on( `data`, chunk => output += chunk )
    child.on( `error`, error => resolve( { error: `spawn`, reason: error.message } ) )
    child.on( `close`, () => {
        try {
            resolve( JSON.parse( output.trim().split( `\n` ).at( -1 ) ) )
        } catch {
            resolve( { error: `mail`, reason: `mail.py printed no result` } )
        }
    } )

} )

/* ---------------------------------------------------------------------------
 * Browser helpers
 * ------------------------------------------------------------------------- */

const click_label = async ( page, pattern ) => {
    for( const handle of await page.$$( `button, [role=button], input[type=submit]` ) ) {
        const label = await handle.evaluate( element => ( element.innerText || element.value || element.getAttribute( `aria-label` ) || `` ).trim() )
        if( pattern.test( label ) && await handle.isVisible() ) {
            await handle.click()
            return true
        }
    }
    return false
}

// The claude.ai account the browser is signed in as: claude.ai's own account
// APIs, else addresses shown on the page. Null when nothing tells.
const signed_in_as = async page => {
    const api = await page.evaluate( async () => {
        for( const path of [ `/api/account`, `/api/bootstrap` ] ) {
            try {
                const response = await fetch( path, { credentials: `include` } )
                const body = response.ok ? await response.json() : {}
                const email = body.email_address || body.account?.email_address
                if( email ) return email
            } catch {
                // try the next source
            }
        }
        return null
    } ).catch( () => null )
    if( api ) return [ api ]
    const text = await page.evaluate( () => document.body?.innerText || `` ).catch( () => `` )
    return text.match( /[\w.+-]+@[\w-]+(\.[\w-]+)+/g ) || null
}

const fill = async ( page, selector, value ) => {
    const input = await page.$( selector )
    if( !input ) return false
    await input.click( { count: 3 } )
    await input.type( value, { delay: 25 } )
    await input.press( `Enter` )
    return true
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */

const result = async () => {

    // Old runs only hold failure screenshots
    mkdirSync( join( args.home, `runs` ), { recursive: true } )
    for( const entry of readdirSync( join( args.home, `runs` ) ) ) {
        const path = join( args.home, `runs`, entry )
        if( Date.now() - statSync( path ).mtimeMs > RUN_RETENTION_MS ) rmSync( path, { recursive: true, force: true } )
    }

    // A crashed run leaves Chrome's lock behind, and each container has a
    // new hostname, so Chrome would think another machine holds the profile
    mkdirSync( profile_dir, { recursive: true, mode: 0o700 } )
    for( const lock of [ `SingletonLock`, `SingletonSocket`, `SingletonCookie` ] ) rmSync( join( profile_dir, lock ), { force: true } )

    const cli = start_cli()
    let browser

    const fail = async ( step, reason, page ) => {
        mkdirSync( run_dir, { recursive: true } )
        if( page ) {
            await page.screenshot( { path: join( run_dir, `page.png` ) } ).catch( () => {} )
            const snapshot = await page.evaluate( snapshot_page ).catch( () => null )
            if( snapshot ) writeFileSync( join( run_dir, `page.json` ), JSON.stringify( { ...snapshot, url: redact( snapshot.url ) }, null, 2 ) )
        }
        return { ok: false, step, reason, run_dir }
    }

    try {

        const launched = Date.now()
        progress( `starting claude ${ args.mode === `token` ? `setup-token` : `auth login` }` )
        while( !cli.authorize_url() ) {
            const outcome = cli.outcome()
            if( outcome?.exit !== undefined ) return await fail( `cli`, `claude exited before printing a sign-in URL: ${ outcome.screen }` )
            if( Date.now() - launched > 120_000 ) return await fail( `cli`, `claude printed no sign-in URL within 2 minutes` )
            await sleep( 500 )
        }

        browser = await puppeteer.launch( {
            headless: false,
            userDataDir: profile_dir,
            args: [ `--window-size=1280,900`, `--no-first-run`, `--no-default-browser-check` ],
            defaultViewport: { width: 1280, height: 900 },
        } )
        const [ page ] = await browser.pages()

        // Seeding: a claude.ai session pasted by the user, kept in the profile
        if( process.env.RELOGIN_SESSION_KEY ) {
            progress( `storing the pasted claude.ai session` )
            await browser.setCookie( {
                name: `sessionKey`, value: process.env.RELOGIN_SESSION_KEY.trim(), domain: `.claude.ai`, path: `/`,
                secure: true, httpOnly: true, sameSite: `Lax`, expires: Math.floor( Date.now() / 1000 ) + 365 * 24 * 3600,
            } )
        }

        progress( `opening the sign-in page` )
        await page.goto( cli.authorize_url(), { waitUntil: `domcontentloaded`, timeout: 60_000 } )

        const started = Date.now() / 1000
        let last_state = null
        let state_since = Date.now()
        let email_sent = false
        let cookies_dismissed = false
        let mail = null

        while( Date.now() < deadline ) {

            const outcome = cli.outcome()
            if( outcome?.token || outcome?.credentials ) return { ok: true, ...outcome }
            if( outcome?.exit !== undefined ) return await fail( `cli`, `claude exited (${ outcome.exit }) without a login: ${ outcome.screen }`, page )

            const snapshot = await page.evaluate( snapshot_page ).catch( () => null )
            if( !snapshot ) {
                await sleep( 1000 )
                continue
            }

            const state = classify_page( snapshot )
            if( state !== last_state ) {
                progress( `page: ${ state } (${ redact( snapshot.url ) })` )
                last_state = state
                state_since = Date.now()
            }

            if( !cookies_dismissed ) cookies_dismissed = await click_label( page, /^reject all cookies$/i )

            // Never solved: a human check means the seeded session is gone
            if( state === `captcha` && Date.now() - state_since > 30_000 ) return await fail( `captcha`, `claude.ai asked for a human check; re-seed the browser session with babysit auth relogin --session-key`, page )
            if( state === `foreign` ) return await fail( `browser`, `the sign-in flow left claude.ai (${ redact( snapshot.url ) })`, page )

            if( state === `consent` ) {
                // Fail closed: setup-tokens record no account, so this is the
                // only point where a wrong-account token can be stopped
                const shown = args.account && await signed_in_as( page )
                if( args.account && !shown ) return await fail( `account`, `could not confirm which claude.ai account the browser is signed in as`, page )
                if( shown && !shown.some( address => address.toLowerCase() === args.account.toLowerCase() ) ) {
                    return await fail( `account`, `the browser is signed in as ${ shown[0] }, not ${ args.account }; re-seed it with babysit auth relogin --session-key`, page )
                }
                progress( `authorizing` )
                await click_label( page, /^(authorize|allow|approve)$/i )
                await sleep( 3000 )
                continue
            }

            if( state === `email_entry` && !email_sent ) {
                if( !args.email ) return await fail( `email`, `the browser session expired and no login email is known; set CLAUDE_LOGIN_EMAIL in ~/.babysitrc`, page )
                progress( `requesting a login email` )
                await fill( page, `input[type=email], input[autocomplete=email]`, args.email )
                email_sent = true
                await sleep( 3000 )
                continue
            }

            if( [ `check_email`, `email_code_entry` ].includes( state ) && !mail ) {
                progress( `waiting for the login email in Gmail` )
                mail = await fetch_login_mail( started )
                if( mail.error ) return await fail( `mail`, mail.reason, page )

                if( mail.link ) {
                    if( !in_hosts( new URL( mail.link ).hostname ) ) return await fail( `mail`, `login link points off claude.ai`, page )
                    progress( `opening the login link` )
                    await page.goto( mail.link, { waitUntil: `domcontentloaded`, timeout: 60_000 } )
                } else {
                    progress( `entering the emailed code` )
                    await fill( page, `input[autocomplete=one-time-code], input[name*=code i], input[id*=code i], input[placeholder*=code i]`, mail.code )
                }
                await sleep( 3000 )
                continue
            }

            if( ![ `callback`, `captcha` ].includes( state ) && Date.now() - state_since > STUCK_MS ) {
                return await fail( `page`, `stuck on an unrecognised ${ state } page for a minute`, page )
            }

            await sleep( 1000 )
        }

        return await fail( `timeout`, `no login before the deadline (last page: ${ last_state })`, ( await browser.pages() )[0] )

    } finally {
        await browser?.close().catch( () => {} )
        cli.stop()
        rmSync( work, { recursive: true, force: true } )
    }

}

const outcome = await result().catch( error => ( { ok: false, step: `driver`, reason: error.message } ) )
process.stdout.write( `RESULT ${ JSON.stringify( outcome ) }\n` )
process.exit( outcome.ok ? 0 : 1 )
