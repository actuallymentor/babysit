import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import {
    cmd_auth_relogin,
    install_login,
    notify_relogin,
    relogin_cap_reason,
    relogin_claude,
    relogin_docker_args,
    relogin_account,
    relogin_enabled,
    relogin_mode,
    run_relogin_container,
    RELOGIN_DAILY_CAP,
} from '../src/cli/relogin.js'
import { classify_page } from '../src/docker/assets/relogin/page_state.mjs'

const MAIL_PY = join( import.meta.dir, `../src/docker/assets/relogin/mail.py` )
const NOW = Date.parse( `2026-10-10T12:00:00Z` )

const collect = () => {
    let text = ``
    return { output: { write: chunk => text += chunk, isTTY: false }, rendered: () => text }
}

let directory
beforeEach( () => {
    directory = mkdtempSync( join( tmpdir(), `babysit-relogin-` ) )
} )
afterEach( () => {
    rmSync( directory, { recursive: true, force: true } )
} )

describe( `relogin settings`, () => {

    it( `turns on with Gmail configured, off with BABYSIT_RELOGIN=0`, () => {
        const gmail = { GMAIL_USER: `a@gmail.com`, GMAIL_APP_PASSWORD: `x` }
        expect( relogin_enabled( {} ) ).toBe( false )
        expect( relogin_enabled( { GMAIL_USER: `a@gmail.com` } ) ).toBe( false )
        expect( relogin_enabled( gmail ) ).toBe( true )
        expect( relogin_enabled( { ...gmail, BABYSIT_RELOGIN: `0` } ) ).toBe( false )
    } )

    it( `replaces the setup-token when sessions use one, else a writable /login file`, () => {
        expect( relogin_mode( { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-x` }, { credential_file: () => null } ) ).toBe( `token` )
        expect( relogin_mode( {}, { credential_file: () => `/home/me/.claude/.credentials.json` } ) ).toBe( `login` )
        // macOS Keychain
        expect( relogin_mode( {}, { credential_file: () => null } ) ).toBe( null )
    } )

    it( `expects the explicit account, else the host CLI's last login`, () => {
        const account = JSON.stringify( { oauthAccount: { emailAddress: `me@work.example` } } )
        expect( relogin_account( { CLAUDE_LOGIN_EMAIL: `set@example.com` }, { read: () => account } ) ).toBe( `set@example.com` )
        expect( relogin_account( { GMAIL_USER: `box@gmail.com` }, { read: () => account } ) ).toBe( `me@work.example` )
        // The Gmail box is only an address to try, never an account to enforce
        expect( relogin_account( { GMAIL_USER: `box@gmail.com` }, { read: () => {
            throw new Error( `ENOENT` )
        } } ) ).toBe( `` )
    } )

    it( `keeps secrets off the docker argv`, () => {
        const args = relogin_docker_args( { mode: `token`, account: `me@x.com`, seccomp_path: `/s.json`, env_file: `/e.env`, name: `n`, image: `img` } )
        expect( args ).toContain( `--env-file` )
        expect( args.join( ` ` ) ).not.toMatch( /GMAIL|SESSION_KEY/ )
        expect( args.slice( args.indexOf( `img` ) ) ).toEqual( [ `img`, `-a`, `node`, `/opt/relogin/driver.mjs`, `--mode`, `token`, `--email`, `me@x.com`, `--account`, `me@x.com` ] )
    } )

    it( `tries once per logout and caps attempts per day`, () => {
        expect( relogin_cap_reason( {}, `login-a`, NOW ) ).toBe( null )
        expect( relogin_cap_reason( { tried: { 'login-a': NOW - 1 } }, `login-a`, NOW ) ).toMatch( /already tried/ )
        const full = { attempts: Array( RELOGIN_DAILY_CAP ).fill( NOW - 1_000 ) }
        expect( relogin_cap_reason( full, `login-b`, NOW ) ).toMatch( /attempts in the last day/ )
        expect( relogin_cap_reason( { attempts: full.attempts.map( () => NOW - 25 * 3600_000 ) }, `login-b`, NOW ) ).toBe( null )
    } )

} )

describe( `relogin_claude`, () => {

    const options = overrides => ( {
        env: {},
        output: collect().output,
        now: NOW,
        state_path: join( directory, `relogin.json` ),
        lock_path: join( directory, `relogin.lock` ),
        account: `me@x.com`,
        ...overrides,
    } )

    it( `saves a minted setup-token and exports it`, async () => {
        const env = { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-dead` }
        const saved = []
        const result = await relogin_claude( options( {
            env, mode: `token`, login: `L1`,
            run: async ( { mode, email } ) => ( { ok: mode === `token` && email === `me@x.com`, token: `sk-ant-oat01-fresh` } ),
            save_token: token => saved.push( token ) && `/rc`,
        } ) )
        expect( result ).toEqual( { ok: true, mode: `token` } )
        expect( saved ).toEqual( [ `sk-ant-oat01-fresh` ] )
        expect( env.CLAUDE_CODE_OAUTH_TOKEN ).toBe( `sk-ant-oat01-fresh` )
        expect( existsSync( join( directory, `relogin.lock` ) ) ).toBe( false )
    } )

    it( `records the attempt so the same logout is not retried, unless run by hand`, async () => {
        const run = async () => ( { ok: false, step: `mail`, reason: `timeout` } )
        expect( await relogin_claude( options( { mode: `token`, login: `L1`, run } ) ) ).toMatchObject( { ok: false, step: `mail` } )
        expect( await relogin_claude( options( { mode: `token`, login: `L1`, run } ) ) ).toMatchObject( { skipped: true } )
        expect( await relogin_claude( options( { mode: `token`, login: `L1`, run, manual: true } ) ) ).toMatchObject( { step: `mail` } )
        expect( statSync( join( directory, `relogin.json` ) ).mode & 0o777 ).toBe( 0o600 )
    } )

    it( `skips while another live run holds the lock, and reclaims a dead one`, async () => {
        const lock_path = join( directory, `relogin.lock` )
        const run = async () => ( { ok: true, token: `sk-ant-oat01-x` } )
        writeFileSync( lock_path, String( process.pid ) )
        expect( await relogin_claude( options( { mode: `token`, manual: true, run } ) ) ).toMatchObject( { skipped: true } )
        writeFileSync( lock_path, `999999999` )
        expect( await relogin_claude( options( { mode: `token`, manual: true, run, save_token: () => `/rc` } ) ) ).toMatchObject( { ok: true } )
    } )

    it( `never installs a login that landed on another account`, async () => {
        const saved = []
        const result = await relogin_claude( options( {
            mode: `token`, manual: true,
            run: async () => ( { ok: true, token: `sk-ant-oat01-other`, account: `Someone@else.example` } ),
            save_token: token => saved.push( token ),
        } ) )
        expect( result ).toMatchObject( { ok: false, step: `account` } )
        expect( saved ).toEqual( [] )
        // Same account, different case: fine
        const same = await relogin_claude( options( { mode: `token`, manual: true, run: async () => ( { ok: true, token: `t`, account: `ME@x.com` } ), save_token: () => `/rc` } ) )
        expect( same.ok ).toBe( true )
    } )

    it( `tries the Gmail box when no account is known, without enforcing it`, async () => {
        const seen = []
        await relogin_claude( options( {
            env: { GMAIL_USER: `box@gmail.com` }, account: ``, mode: `token`, manual: true,
            run: async ( { account, email } ) => seen.push( { account, email } ) && { ok: true, token: `t`, account: `me@work.example` },
            save_token: () => `/rc`,
        } ) )
        expect( seen ).toEqual( [ { account: ``, email: `box@gmail.com` } ] )
    } )

    it( `says why a Keychain login cannot be replaced`, async () => {
        expect( await relogin_claude( options( { mode: null } ) ) ).toMatchObject( { ok: false, step: `mode` } )
    } )

    it( `installs a fresh /login over the old one, keeping other keys`, () => {
        const path = join( directory, `.credentials.json` )
        writeFileSync( path, JSON.stringify( { claudeAiOauth: { accessToken: `old` }, mcpOAuth: { keep: true } } ) )
        install_login( { claudeAiOauth: { accessToken: `new`, refreshToken: `r` } }, path )
        expect( JSON.parse( readFileSync( path, `utf8` ) ) ).toEqual( { claudeAiOauth: { accessToken: `new`, refreshToken: `r` }, mcpOAuth: { keep: true } } )
        expect( statSync( path ).mode & 0o777 ).toBe( 0o600 )
    } )

} )

describe( `run_relogin_container`, () => {

    const fake_spawn = ( stdout, { code = 0, stderr = `` } = {} ) => {
        const calls = []
        const spawn_fn = ( bin, args ) => {
            calls.push( { bin, args } )
            const child = new EventEmitter()
            child.stdout = new PassThrough()
            child.stderr = new PassThrough()
            if( args.includes( `run` ) ) {
                // The env file must exist while docker reads it
                const env_file = args[ args.indexOf( `--env-file` ) + 1 ]
                calls.at( -1 ).env_file = readFileSync( env_file, `utf8` )
                setTimeout( () => {
                    child.stderr.end( stderr )
                    child.stdout.end( stdout )
                    setTimeout( () => child.emit( `close`, code ), 5 )
                }, 1 )
            }
            return child
        }
        return { spawn_fn, calls }
    }

    it( `reads the RESULT line, forwards progress, and passes secrets in an env file`, async () => {
        const { spawn_fn, calls } = fake_spawn( `noise\nRESULT {"ok":true,"token":"sk-ant-oat01-z"}\n`, { stderr: `relogin: page: consent (https://claude.ai/oauth/authorize)\nchrome noise\n` } )
        const { output, rendered } = collect()
        const env = { GMAIL_USER: `a@gmail.com`, GMAIL_APP_PASSWORD: `pw`, PATH: process.env.PATH }
        const result = await run_relogin_container( { mode: `token`, email: `me@x.com`, env, output, spawn_fn } )

        expect( result ).toEqual( { ok: true, token: `sk-ant-oat01-z` } )
        expect( calls[0].bin ).toBe( `docker` )
        expect( calls[0].env_file ).toBe( `GMAIL_USER=a@gmail.com\nGMAIL_APP_PASSWORD=pw\n` )
        expect( calls[0].args.join( ` ` ) ).not.toContain( `pw` )
        expect( rendered() ).toBe( `relogin: page: consent (https://claude.ai/oauth/authorize)\n` )
        // Private files are gone afterwards
        expect( existsSync( calls[0].args[ calls[0].args.indexOf( `--env-file` ) + 1 ] ) ).toBe( false )
    } )

    it( `points an old image at babysit update`, async () => {
        const { spawn_fn } = fake_spawn( ``, { code: 1, stderr: `Error: Cannot find module '/opt/relogin/driver.mjs'\n` } )
        expect( await run_relogin_container( { mode: `token`, email: ``, env: {}, output: collect().output, spawn_fn } ) )
            .toMatchObject( { ok: false, step: `docker`, reason: expect.stringContaining( `babysit update` ) } )
    } )

} )

describe( `babysit auth relogin`, () => {

    it( `reports the outcome and exit code`, async () => {
        const { output, rendered } = collect()
        const proven = []
        const prove = async outcome => proven.push( outcome ) && outcome
        expect( await cmd_auth_relogin( { flags: {} }, { output, env: {}, prove, relogin: async ( { manual } ) => ( { ok: manual, mode: `token` } ) } ) ).toBe( 0 )
        // By hand too, the new login is proven and Claude re-enrolled
        expect( proven ).toEqual( [ { ok: true, mode: `token` } ] )
        expect( rendered() ).toContain( `Restart running Claude sessions` )
        expect( await cmd_auth_relogin( { flags: {} }, { output, env: {}, prove, relogin: async () => ( { ok: false, step: `captcha`, reason: `human check`, run_dir: `/r` } ) } ) ).toBe( 1 )
        expect( rendered() ).toContain( `Re-login failed at captcha: human check (screenshot: /r in volume babysit-relogin)` )
    } )

    it( `takes a pasted sessionKey only from a terminal, and only when it looks right`, async () => {
        const relogin = async ( { env } ) => ( { ok: true, mode: `login`, key: env.RELOGIN_SESSION_KEY } )
        await expect( cmd_auth_relogin( { flags: { session_key: true } }, { input: { isTTY: false }, relogin } ) ).rejects.toThrow( /terminal/ )

        const paste = text => {
            const input = new PassThrough()
            input.isTTY = true
            input.end( `${ text }\n` )
            return input
        }
        const seen = []
        const spy = async options => seen.push( options.env.RELOGIN_SESSION_KEY ) && { ok: true, mode: `login` }
        expect( await cmd_auth_relogin( { flags: { session_key: true } }, { input: paste( `not-a-key` ), output: collect().output, env: {}, relogin: spy, prove: async outcome => outcome } ) ).toBe( 1 )
        expect( await cmd_auth_relogin( { flags: { session_key: true } }, { input: paste( `sk-ant-sid01-abc_DEF-1` ), output: collect().output, env: {}, relogin: spy, prove: async outcome => outcome } ) ).toBe( 0 )
        expect( seen ).toEqual( [ `sk-ant-sid01-abc_DEF-1` ] )
    } )

    it( `pushes a success note with the next step`, async () => {
        const sent = []
        await notify_relogin( { ok: true, mode: `token` }, { notify: async message => sent.push( message ) } )
        expect( sent[0].message ).toContain( `babysit restart` )
    } )

} )

describe( `sign-in page classifier`, () => {

    const page = overrides => ( { url: `https://claude.ai/login`, title: `Sign in - Claude`, text: ``, buttons: [], ...overrides } )

    it( `recognises each step of the flow`, () => {
        expect( classify_page( page( { email_input: true, buttons: [ `Continue with Google`, `Continue with email` ] } ) ) ).toBe( `email_entry` )
        expect( classify_page( page( { text: `Check your email. We sent you a login link.` } ) ) ).toBe( `check_email` )
        expect( classify_page( page( { text: `Enter the code`, code_input: true } ) ) ).toBe( `email_code_entry` )
        expect( classify_page( page( { url: `https://claude.ai/oauth/authorize`, buttons: [ `Decline`, `Authorize` ] } ) ) ).toBe( `consent` )
        expect( classify_page( page( { url: `http://localhost:40123/callback?code=x` } ) ) ).toBe( `callback` )
    } )

    it( `ignores Cloudflare's passive widget but flags a real challenge`, () => {
        expect( classify_page( page( { email_input: true, buttons: [ `Continue with email` ], captcha_frame: true } ) ) ).toBe( `email_entry` )
        expect( classify_page( page( { text: `Verify you are human`, buttons: [ `Authorize` ] } ) ) ).toBe( `captcha` )
        expect( classify_page( page( { url: `https://claude.ai/api/challenge_redirect`, title: `Just a moment...` } ) ) ).toBe( `captcha` )
    } )

    it( `never acts on other hosts`, () => {
        expect( classify_page( page( { url: `https://claude.ai.evil.example/login`, buttons: [ `Authorize` ] } ) ) ).toBe( `foreign` )
        expect( classify_page( page( { url: `https://platform.claude.com/oauth/code/callback` } ) ) ).toBe( `unknown` )
    } )

} )

describe( `login email judge (mail.py)`, () => {

    const SINCE = Date.parse( `2026-10-10T12:00:00Z` ) / 1000
    const GMAIL_PASS = `Authentication-Results: mx.google.com;\r\n       dkim=pass header.i=@mail.anthropic.com header.s=s1 header.b=abc;\r\n       spf=pass smtp.mailfrom=mail.anthropic.com`

    const eml = ( { from = `Anthropic <no-reply@mail.anthropic.com>`, date = `Sat, 10 Oct 2026 12:00:30 +0000`, stamps = [ GMAIL_PASS ], body = `<a href="https://claude.ai/magic-link#abc:def">Sign in</a> <a href="https://www.anthropic.com/legal/privacy">Privacy</a>` } = {} ) => [
        ...stamps,
        `From: ${ from }`,
        `To: me@work.example`,
        `Subject: Secure link to log in to Claude.ai`,
        `Date: ${ date }`,
        `MIME-Version: 1.0`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        body,
    ].join( `\r\n` )

    const judge = ( message, env = {} ) => {
        const file = join( directory, `message.eml` )
        writeFileSync( file, message )
        const run = spawnSync( `python3`, [ `-I`, MAIL_PY, `--since`, String( SINCE ), `--check`, file ], { encoding: `utf8`, env: { PATH: process.env.PATH, ...env } } )
        return JSON.parse( run.stdout )
    }

    it( `accepts Gmail-verified Anthropic mail and picks the login link`, () => {
        expect( judge( eml() ) ).toEqual( { link: `https://claude.ai/magic-link#abc:def` } )
    } )

    it( `rejects other senders, failed or forged DKIM, and stale mail`, () => {
        expect( judge( eml( { from: `Anthropic <no-reply@anthropic.com.evil.example>` } ) ).reason ).toMatch( /not allowlisted/ )
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `dkim=pass`, `dkim=fail` ) ] } ) ).reason ).toMatch( /DKIM/ )
        // A pass the sender wrote sits below Gmail's own stamp and does not count
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `dkim=pass`, `dkim=fail` ), GMAIL_PASS ] } ) ).reason ).toMatch( /DKIM/ )
        // DKIM must be the From domain's, not the attacker's
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `@mail.anthropic.com`, `@evil.example` ) ] } ) ).reason ).toMatch( /DKIM/ )
        // An identity's local part may hold '@': only the domain after the last one signs
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `header.i=@mail.anthropic.com`, `header.i=anthropic.com@evil.example` ) ] } ) ).reason ).toMatch( /DKIM/ )
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `header.i=@mail.anthropic.com`, `header.i=anthropic.com@evil.example header.d=evil.example` ) ] } ) ).reason ).toMatch( /DKIM/ )
        expect( judge( eml( { stamps: [ GMAIL_PASS.replace( `header.i=@mail.anthropic.com`, `header.d=mail.anthropic.com` ) ] } ) ) ).toHaveProperty( `link` )
        expect( judge( eml( { date: `Sat, 10 Oct 2026 11:50:00 +0000` } ) ).reason ).toMatch( /predates/ )
    } )

    it( `ignores links off claude.ai, and falls back to an emailed code`, () => {
        expect( judge( eml( { body: `<a href="https://evil.example/magic-link">Sign in</a>` } ) ).reason ).toMatch( /no login link/ )
        expect( judge( eml( { body: `<p>Your verification code is <b>482913</b></p>` } ) ) ).toEqual( { code: `482913` } )
    } )

    it( `honours a sender override`, () => {
        expect( judge( eml(), { BABYSIT_RELOGIN_SENDERS: `example.org` } ).reason ).toMatch( /not allowlisted/ )
    } )

} )
