import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

import { get_agent } from '../agents/index.js'
import { run_auth_diagnostics } from './doctor.js'
import { host_credential_file } from '../agents/host_probe.js'
import { create_chrome_seccomp_profile } from '../docker/chrome-seccomp.js'
import { docker_command_prefix, WATCHTOWER_DISABLE_LABEL } from '../docker/run.js'
import { get_image_name } from '../docker/update.js'
import { notify_pushover } from '../utils/notify.js'
import { BABYSIT_DIR } from '../utils/paths.js'
import { build_private_tmpfile } from '../utils/tmpfile.js'
import { CLAUDE_TOKEN_ENV, save_claude_token } from './claude_token.js'

/*
 * Automated Claude re-login (.notes/AUTO_LOGIN_DESIGN.md, option B).
 *
 * A throwaway babysit container runs /opt/relogin/driver.mjs: the claude CLI
 * mints the login, Chrome authorizes it with a persistent claude.ai session
 * (Docker volume `babysit-relogin`), and Gmail supplies the login link when
 * that session has expired. The host then installs the result:
 *
 * - token mode (CLAUDE_CODE_OAUTH_TOKEN set): a new setup-token in ~/.babysitrc
 * - login mode (file /login on Linux): a new claudeAiOauth in the credential file
 */

export const RELOGIN_VOLUME = `babysit-relogin`
export const RELOGIN_STATE_PATH = join( BABYSIT_DIR, `relogin.json` )
export const RELOGIN_LOCK_PATH = join( BABYSIT_DIR, `relogin.lock` )
export const RELOGIN_DAILY_CAP = 3
export const RELOGIN_TIMEOUT_MS = 15 * 60_000
const DAY_MS = 24 * 3600_000

/**
 * Automatic re-login runs once Gmail is configured, unless BABYSIT_RELOGIN=0.
 * @param {Object} [env] - Environment
 * @returns {boolean} Enabled
 */
export const relogin_enabled = ( env = process.env ) => Boolean( env.GMAIL_USER && env.GMAIL_APP_PASSWORD ) && env.BABYSIT_RELOGIN !== `0`

/**
 * Which login to mint: the setup-token outranks /login, so replace whichever
 * one sessions actually use. Keychain logins (macOS /login) cannot be written.
 * @param {Object} [env] - Environment
 * @param {Object} [options] - Credential file seam
 * @returns {'token'|'login'|null} Mode
 */
export const relogin_mode = ( env = process.env, { credential_file = () => host_credential_file( get_agent( `claude` ) ) } = {} ) => {
    if( env[ CLAUDE_TOKEN_ENV ] ) return `token`
    return credential_file() ? `login` : null
}

/**
 * The Claude account a re-login must land on: CLAUDE_LOGIN_EMAIL, else the
 * account the host CLI last logged in as. Empty when neither is known.
 * @param {Object} [env] - Environment
 * @param {Object} [options] - Path and reader seams
 * @returns {string} Account email, possibly empty
 */
export const relogin_account = ( env = process.env, {
    path = join( env.CLAUDE_CONFIG_DIR || homedir(), `.claude.json` ),
    read = file => readFileSync( file, `utf8` ),
} = {} ) => {
    if( env.CLAUDE_LOGIN_EMAIL ) return env.CLAUDE_LOGIN_EMAIL
    try {
        return JSON.parse( read( path ) ).oauthAccount?.emailAddress || ``
    } catch {
        return ``
    }
}

// Driver inputs that are secrets travel in a 0600 env file, never on argv
export const RELOGIN_SECRET_ENV = [ `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `BABYSIT_RELOGIN_SENDERS`, `RELOGIN_SESSION_KEY` ]

/**
 * docker argv for one driver run.
 * @param {Object} options - mode, account, email, seccomp_path, env_file, name, image
 * @returns {string[]} Arguments after the docker binary
 */
export const relogin_docker_args = ( { mode, account = ``, email = account, seccomp_path, env_file, name, image = get_image_name() } ) => [
    `run`, `--rm`, `--init`, `--shm-size=1g`,
    `--security-opt`, `seccomp=${ seccomp_path }`,
    `--label`, WATCHTOWER_DISABLE_LABEL,
    `--name`, name,
    `-v`, `${ RELOGIN_VOLUME }:/home/node/relogin`,
    `--env-file`, env_file,
    `--user`, `node`, `--entrypoint`, `xvfb-run`,
    image, `-a`, `node`, `/opt/relogin/driver.mjs`, `--mode`, mode, `--email`, email, `--account`, account,
]

/**
 * Run the driver container and read its RESULT line.
 * @param {Object} options - mode, email, env, output, and process seams
 * @returns {Promise<Object>} Driver result
 */
export const run_relogin_container = ( { mode, account, email, env = process.env, output = process.stdout, spawn_fn = spawn, timeout_ms = RELOGIN_TIMEOUT_MS } ) => new Promise( resolve => {

    const name = `babysit-relogin-${ randomUUID().slice( 0, 8 ) }`
    const seccomp = create_chrome_seccomp_profile()
    const secrets = build_private_tmpfile( `relogin`, `env`, RELOGIN_SECRET_ENV
        .filter( key => env[ key ] )
        .map( key => `${ key }=${ env[ key ].replace( /\n/g, `` ) }\n` )
        .join( `` ) )
    const cleanup = () => [ seccomp, secrets ].forEach( transport => transport && rmSync( transport.directory, { recursive: true, force: true } ) )
    if( !secrets ) {
        cleanup()
        return resolve( { ok: false, step: `docker`, reason: `could not write the private env file` } )
    }

    const [ docker, ...prefix ] = docker_command_prefix( { env } )
    const child = spawn_fn( docker, [ ...prefix, ...relogin_docker_args( { mode, account, email, seccomp_path: seccomp.file, env_file: secrets.file, name } ) ], { env, stdio: [ `ignore`, `pipe`, `pipe` ] } )

    let stdout = ``
    let missing_driver = false
    child.stdout.on( `data`, chunk => stdout += chunk )
    createInterface( { input: child.stderr } ).on( `line`, line => {
        if( line.startsWith( `relogin:` ) ) output.write( `${ line }\n` )
        if( /cannot find module.*\/opt\/relogin/i.test( line ) ) missing_driver = true
    } )

    const timer = setTimeout( () => spawn_fn( docker, [ ...prefix, `kill`, name ], { stdio: `ignore` } ), timeout_ms )
    timer.unref?.()

    child.on( `error`, error => {
        cleanup()
        resolve( { ok: false, step: `docker`, reason: error.message } )
    } )
    child.on( `close`, code => {
        clearTimeout( timer )
        cleanup()
        const line = stdout.split( `\n` ).findLast( entry => entry.startsWith( `RESULT ` ) )
        try {
            resolve( JSON.parse( line.slice( 7 ) ) )
        } catch {
            resolve( { ok: false, step: `docker`, reason: missing_driver ? `the babysit image predates re-login; run babysit update` : `the re-login container exited (${ code }) without a result` } )
        }
    } )

} )

/**
 * Put fresh /login credentials in place of the host's, keeping any other keys
 * (MCP logins) in the file. Atomic, 0600.
 * @param {Object} credentials - Driver's .credentials.json content
 * @param {string} path - Host credential file
 */
export const install_login = ( credentials, path ) => {
    let current = {}
    try {
        current = JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        // missing or unreadable: start fresh
    }
    mkdirSync( dirname( path ), { recursive: true } )
    const temporary = `${ path }.${ process.pid }.relogin.tmp`
    writeFileSync( temporary, `${ JSON.stringify( { ...current, claudeAiOauth: credentials.claudeAiOauth }, null, 2 ) }\n`, { mode: 0o600 } )
    renameSync( temporary, path )
}

// One run at a time across processes; a dead holder's lock is reclaimed
const take_lock = path => {
    mkdirSync( dirname( path ), { recursive: true } )
    for( const attempt of [ 1, 2 ] ) {
        try {
            const handle = openSync( path, `wx`, 0o600 )
            writeSync( handle, String( process.pid ) )
            closeSync( handle )
            return () => rmSync( path, { force: true } )
        } catch ( error ) {
            if( error.code !== `EEXIST` || attempt === 2 ) return null
            const holder = Number( readFileSync( path, `utf8` ) )
            try {
                process.kill( holder, 0 )
                return null
            } catch {
                rmSync( path, { force: true } )
            }
        }
    }
    return null
}

const read_state = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        return {}
    }
}

/**
 * Whether the automatic path may try now: once per lost login, and at most
 * RELOGIN_DAILY_CAP times a day, so a broken flow alerts instead of looping.
 * @param {Object} state - { attempts: [ms], tried: { login: ms } }
 * @param {string} login - The lost login's authenticated_at
 * @param {number} now - Clock
 * @returns {string|null} Reason to skip, or null
 */
export const relogin_cap_reason = ( state, login, now ) => {
    if( state.tried?.[ login ] ) return `already tried for this logout`
    const recent = ( state.attempts || [] ).filter( at => now - at < DAY_MS )
    return recent.length >= RELOGIN_DAILY_CAP ? `${ RELOGIN_DAILY_CAP } attempts in the last day` : null
}

/**
 * Mint and install a fresh Claude login.
 * @param {Object} [options] - manual (skip caps), login key, and seams
 * @returns {Promise<Object>} { ok, mode?, step?, reason?, skipped? }
 */
export const relogin_claude = async ( {
    env = process.env,
    output = process.stdout,
    manual = false,
    login = `unknown`,
    now = Date.now(),
    state_path = RELOGIN_STATE_PATH,
    lock_path = RELOGIN_LOCK_PATH,
    mode = relogin_mode( env ),
    account = relogin_account( env ),
    run = run_relogin_container,
    save_token = save_claude_token,
    credential_file = () => host_credential_file( get_agent( `claude` ) ),
} = {} ) => {

    if( !mode ) return { ok: false, step: `mode`, reason: `a macOS Keychain login cannot be replaced; switch to a setup-token with babysit auth init --claude-token` }

    const state = read_state( state_path )
    const capped = !manual && relogin_cap_reason( state, login, now )
    if( capped ) return { ok: false, skipped: true, reason: capped }

    const release = take_lock( lock_path )
    if( !release ) return { ok: false, skipped: true, reason: `another re-login is running` }

    try {

        const attempts = [ ...( state.attempts || [] ).filter( at => now - at < DAY_MS ), now ]
        mkdirSync( dirname( state_path ), { recursive: true } )
        // Only the current logout's key matters; older ones never come back
        const tried = manual ? state.tried || {} : { [ login ]: now }
        writeFileSync( state_path, JSON.stringify( { attempts, tried } ), { mode: 0o600 } )

        output.write( `Re-login: minting a ${ mode === `token` ? `setup-token` : `/login` } in a babysit container…\n` )
        // Without a known account, the Gmail box is the best address to try
        const result = await run( { mode, account, email: account || env.GMAIL_USER || ``, env, output } )
        if( !result.ok ) return { ...result, mode }

        // A login for anyone else must never replace this one
        if( account && result.account && result.account.toLowerCase() !== account.toLowerCase() ) {
            return { ok: false, mode, step: `account`, reason: `the new login belongs to ${ result.account }, not ${ account }; nothing installed` }
        }

        if( mode === `token` ) {
            const path = save_token( result.token )
            env[ CLAUDE_TOKEN_ENV ] = result.token
            output.write( `Re-login: saved a new ${ CLAUDE_TOKEN_ENV } to ${ path }.\n` )
        } else {
            const path = credential_file()
            install_login( result.credentials, path )
            output.write( `Re-login: installed a fresh /login in ${ path }.\n` )
        }
        return { ok: true, mode }

    } finally {
        release()
    }

}

/**
 * Prove a freshly installed login with one container probe, which also
 * re-enrols Claude in the auth cache (the logout cleared its entry). Only a
 * definite `unauthenticated` fails it: a yield or network blip leaves the
 * installed login for the next launch to prove.
 * @param {Object} outcome - relogin_claude result
 * @param {Object} [options] - Output and run_auth_diagnostics options/seams
 * @returns {Promise<Object>} The outcome, or a `verify` failure
 */
export const prove_relogin = async ( outcome, { output = process.stdout, ...diagnostics } = {} ) => {
    if( !outcome.ok ) return outcome
    const [ proof ] = await run_auth_diagnostics( [ get_agent( `claude` ) ], {
        output,
        input: { isTTY: false },
        ttl_ms: 0,
        only_with_credentials: true,
        clear_on_failure: false,
        ...diagnostics,
    } )
    return proof?.status === `unauthenticated`
        ? { ok: false, mode: outcome.mode, step: `verify`, reason: `the new login did not pass a container check${ proof.reason ? ` (${ proof.reason })` : `` }` }
        : outcome
}

/**
 * Pushover line for a finished automatic attempt.
 * @param {Object} result - relogin_claude result
 * @param {Object} [options] - Notifier seam
 * @returns {Promise<boolean>} Delivered
 */
export const notify_relogin = ( result, { notify = notify_pushover } = {} ) => notify( result.ok
    ? {
        title: `Babysit: Claude logged back in`,
        message: result.mode === `token`
            ? `Minted a new setup-token automatically. Restart running Claude sessions (babysit restart N) so they use it.`
            : `Installed a fresh /login automatically; running sessions pick it up.`,
    }
    : {
        title: `Babysit: Claude re-login failed`,
        message: `Step ${ result.step }: ${ result.reason }.${ result.run_dir ? ` Screenshot: ${ result.run_dir } in volume ${ RELOGIN_VOLUME }.` : `` }`,
    } )

const ask = ( { input, output }, question ) => new Promise( resolve => {
    const reader = createInterface( { input, output } )
    reader.question( question, answer => {
        reader.close()
        resolve( answer.trim() )
    } )
} )

/**
 * `babysit auth relogin [claude] [--session-key]`: run the re-login now,
 * ignoring the automatic caps. --session-key first seeds the browser with a
 * claude.ai session pasted from a logged-in browser.
 * @param {Object} cmd - Parsed command
 * @param {Object} [options] - Streams, environment, and seams
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth_relogin = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    env = process.env,
    relogin = relogin_claude,
    prove = prove_relogin,
} = {} ) => {

    if( cmd.agent && cmd.agent !== `claude` ) throw new Error( `babysit auth relogin supports claude only` )

    if( cmd.flags?.session_key ) {
        if( !input.isTTY ) throw new Error( `babysit auth relogin --session-key needs a terminal to paste into` )
        output.write( [
            `Log in at https://claude.ai in a private browser window, then copy the sessionKey cookie`,
            `(DevTools → Application → Cookies → https://claude.ai → sessionKey). Close the window without logging out.`,
            ``,
        ].join( `\n` ) )
        const key = await ask( { input, output }, `sessionKey: ` )
        if( !/^sk-ant-sid\d+-[\w-]+$/.test( key ) ) {
            output.write( `That does not look like a claude.ai sessionKey (sk-ant-sid…); nothing changed.\n` )
            return 1
        }
        // Set on the real env: the installed token must reach the proof
        env.RELOGIN_SESSION_KEY = key
    }

    const installed = await relogin( { env, output, manual: true } ).finally( () => delete env.RELOGIN_SESSION_KEY )
    const result = await prove( installed, { output } )
    if( result.ok ) {
        output.write( `Claude is logged in again.${ result.mode === `token` ? ` Restart running Claude sessions to use the new token.` : `` }\n` )
        return 0
    }
    output.write( `Re-login failed at ${ result.step }: ${ result.reason }${ result.run_dir ? ` (screenshot: ${ result.run_dir } in volume ${ RELOGIN_VOLUME })` : `` }\n` )
    return 1

}
