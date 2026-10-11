import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import {
    clear_host_auth_cache,
    HOST_AUTH_CACHE_TTL_MS,
    read_host_auth_cache,
    resolve_auth_image_identity,
    stamp_host_verification,
} from '../agents/auth_cache.js'
import { read_host_credential, run_host_cli_auth_check } from '../agents/host_probe.js'
import { list_sessions } from '../tmux/session.js'
import { acquire_host_auth_lease, is_host_auth_lease_wanted } from '../agents/auth_lease.js'
import { run } from '../utils/exec.js'
import { alert_high_usage, alert_logouts, pushover_configured } from '../utils/notify.js'
import { collect_usage } from '../docker/assets/usage/command.mjs'
import { format_auth_result_line, run_auth_diagnostics } from './doctor.js'
import { unit_quote } from './recover_init.js'
import { CLAUDE_TOKEN_ENV, setup_claude_token } from './claude_token.js'

// The checker ticks every ten minutes. Offline checks run every tick, host
// CLI probes once the last proof is an hour old, and the container re-probe
// at half the TTL, so a launch always finds a success with hours left.
export const AUTH_CHECK_INTERVAL_S = 10 * 60
export const AUTH_CHECK_REFRESH_AFTER_MS = HOST_AUTH_CACHE_TTL_MS / 2
export const HOST_CHECK_AFTER_MS = 60 * 60_000
export const OFFLINE_RECHECK_MS = 1_000
export const AUTH_CHECK_YIELD_POLL_MS = 250

const SYSTEMD_UNIT = `babysit-auth`
const LAUNCHD_LABEL = `dev.babysit.auth`

const sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) )
const hours = milliseconds => `${ ( milliseconds / 3_600_000 ).toFixed( 1 ) }h`
const timestamp = iso => iso.replace( `T`, ` ` ).replace( /\.\d{3}Z$/, ` UTC` )

/**
 * Agents worth keeping warm: those with a past success on record whose cache
 * identity does not depend on the launching workspace. The checker refreshes
 * verified logins; launches and `doctor --auth` discover new ones. A CLI that
 * never authenticated would otherwise fail a full probe every hour, and an
 * agent with per-project routes (OpenCode) would have its project entry
 * replaced by the scheduler's default route.
 *
 * @param {Object} [options] - Cache seam
 * @returns {Object[]} Agent adapters
 */
export const select_auth_check_agents = ( { cache = read_host_auth_cache() } = {} ) => SUPPORTED_AGENTS
    .map( get_agent )
    .filter( agent => agent && cache.agents?.[ agent.name ] && typeof agent.auth_check?.cache_context !== `function` )

const workspace_route_agents = () => SUPPORTED_AGENTS
    .map( get_agent )
    .filter( agent => typeof agent?.auth_check?.cache_context === `function` )
    .map( agent => agent.name )

/**
 * Summarise the authentication cache for one agent.
 * @param {string} name - Agent name
 * @param {Object} cache - Parsed host auth cache
 * @param {Object} [options] - Current image identity and clock
 * @returns {{ name: string, verified: string, age: string, state: string }} Table row
 */
export const describe_auth_cache_entry = ( name, cache, {
    image_identity = null,
    now = Date.now(),
    ttl_ms = HOST_AUTH_CACHE_TTL_MS,
} = {} ) => {

    const entry = cache.agents?.[ name ]
    const authenticated_at = Date.parse( entry?.authenticated_at )
    if( !Number.isFinite( authenticated_at ) ) return { name, verified: `-`, age: `-`, state: `missing` }

    const age_ms = now - authenticated_at
    const state = age_ms >= ttl_ms ? `expired`
        : image_identity && entry.image_identity !== image_identity ? `stale image`
            : age_ms >= AUTH_CHECK_REFRESH_AFTER_MS ? `due for refresh`
                : `fresh`

    return { name, verified: timestamp( entry.authenticated_at ), age: hours( age_ms ), state }

}

/**
 * Render the cache rows as an aligned table.
 * @param {Object[]} rows - describe_auth_cache_entry results
 * @returns {string} Table text ending in a newline
 */
export const format_auth_status_table = rows => {

    const columns = [ `name`, `verified`, `age`, `state` ]
    const headers = { name: `AGENT`, verified: `VERIFIED`, age: `AGE`, state: `STATE` }
    const widths = Object.fromEntries( columns.map( column => [
        column,
        Math.max( headers[ column ].length, ...rows.map( row => String( row[ column ] ).length ) ),
    ] ) )
    const line = row => columns.map( column => String( row[ column ] ).padEnd( widths[ column ] ) ).join( `  ` ).trimEnd()

    return [ line( headers ), ...rows.map( line ) ].join( `\n` ) + `\n`

}

/* ---------- scheduled checker rendering ---------- */

/**
 * Resolve how the scheduler must invoke this executable.
 * @param {Object} [options] - Process seams
 * @returns {string[]} Absolute command prefix
 */
export const resolve_checker_command = ( { exec_path = process.execPath, script = process.argv[ 1 ] } = {} ) => {

    const compiled = !script || script.startsWith( `/$bunfs` )
    return compiled ? [ exec_path ] : [ exec_path, resolve( script ) ]

}

/**
 * Environment the checker needs: the user's PATH plus any Babysit/Docker
 * overrides active now, so the timer verifies the same setup launches use.
 * @param {Object} [env=process.env] - Source environment
 * @returns {Object<string,string>} Environment entries
 */
export const checker_environment = ( env = process.env ) => Object.fromEntries(
    [ `PATH`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`, `BABYSIT_HOME`, `BABYSIT_DOCKER_IMAGE`, `BABYSIT_DOCKER_USE_SUDO`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR` ]
        .filter( key => env[ key ] )
        .map( key => [ key, env[ key ] ] )
)

/**
 * Render the systemd user service and timer pair.
 * @param {Object} options - Command and environment
 * @returns {{ service: string, timer: string }} Unit file contents
 */
export const render_auth_timer_units = ( { command, environment = {} } ) => {

    if( !command?.length || command.some( item => !isAbsolute( item ) ) ) throw new Error( `The auth checker requires absolute executable paths` )
    const launch = command.map( ( item, index ) => unit_quote( item, index > 0 ) ).join( ` ` )
    const env_lines = Object.entries( environment ).map( ( [ key, value ] ) => `Environment=${ unit_quote( `${ key }=${ value }` ) }` )

    const service = `[Unit]
Description=Babysit host authentication checker
After=network-online.target

[Service]
Type=oneshot
${ env_lines.join( `\n` ) }
ExecStart=${ launch } auth check
TimeoutStartSec=600
`
    const timer = `[Unit]
Description=Babysit authentication check (every 10 minutes)

[Timer]
OnBootSec=5min
OnUnitActiveSec=${ AUTH_CHECK_INTERVAL_S }
Persistent=true

[Install]
WantedBy=timers.target
`
    return { service, timer }

}

const xml_escape = value => String( value ).replace( /[<>&]/g, char => ( { '<': `&lt;`, '>': `&gt;`, '&': `&amp;` }[ char ] ) )

/**
 * Render the launchd agent for macOS.
 * @param {Object} options - Command, environment, and log path
 * @returns {string} Property list XML
 */
export const render_auth_launch_agent = ( { command, environment = {}, log_path } ) => {

    if( !command?.length || command.some( item => !isAbsolute( item ) ) ) throw new Error( `The auth checker requires absolute executable paths` )
    const strings = items => items.map( item => `        <string>${ xml_escape( item ) }</string>` ).join( `\n` )
    const env_entries = Object.entries( environment )
        .map( ( [ key, value ] ) => `        <key>${ xml_escape( key ) }</key>\n        <string>${ xml_escape( value ) }</string>` )
        .join( `\n` )

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${ LAUNCHD_LABEL }</string>
    <key>ProgramArguments</key>
    <array>
${ strings( [ ...command, `auth`, `check` ] ) }
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${ env_entries }
    </dict>
    <key>StartInterval</key>
    <integer>${ AUTH_CHECK_INTERVAL_S }</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${ xml_escape( log_path ) }</string>
    <key>StandardErrorPath</key>
    <string>${ xml_escape( log_path ) }</string>
</dict>
</plist>
`

}

/**
 * Where the scheduler files live for this platform, or null when unsupported.
 * @param {Object} [options] - Platform and home seams
 * @returns {Object|null} Scheduler descriptor
 */
export const resolve_checker_scheduler = ( {
    platform = process.platform,
    home = homedir(),
    exists = existsSync,
} = {} ) => {

    if( platform === `linux` && exists( `/run/systemd/system` ) ) {
        const directory = join( home, `.config`, `systemd`, `user` )
        return {
            kind: `systemd`,
            label: `${ SYSTEMD_UNIT }.timer`,
            files: [ join( directory, `${ SYSTEMD_UNIT }.service` ), join( directory, `${ SYSTEMD_UNIT }.timer` ) ],
            installed: exists( join( directory, `${ SYSTEMD_UNIT }.timer` ) ),
        }
    }

    if( platform === `darwin` ) {
        const plist = join( home, `Library`, `LaunchAgents`, `${ LAUNCHD_LABEL }.plist` )
        return { kind: `launchd`, label: LAUNCHD_LABEL, files: [ plist ], installed: exists( plist ) }
    }

    return null

}

/**
 * One-line nudge for a launch that just paid a real probe while no scheduled
 * checker exists; null when the checker is installed or unsupported here.
 * @param {Object[]} results - Startup authentication results
 * @param {Object} [options] - Scheduler seam
 * @returns {string|null} Hint text
 */
export const auth_checker_hint = ( results = [], { scheduler = resolve_checker_scheduler() } = {} ) => {

    const probed = results.some( result => result.status === `authenticated` )
    if( !probed || !scheduler || scheduler.installed ) return null
    return `This launch verified authentication with a real probe. Run babysit auth init once to keep logins verified in the background.`

}

/* ---------- commands ---------- */

/**
 * Show cache ages and whether the scheduled checker is installed.
 * @param {Object} [options] - Output and seams
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth_status = async ( {
    output = process.stdout,
    cache_path = undefined,
    resolve_image_identity = resolve_auth_image_identity,
    scheduler = resolve_checker_scheduler(),
    now = Date.now(),
} = {} ) => {

    const cache = read_host_auth_cache( cache_path ? { cache_path } : {} )
    const image_identity = await resolve_image_identity()
    const rows = SUPPORTED_AGENTS.map( name => describe_auth_cache_entry( name, cache, { image_identity, now } ) )

    output.write( format_auth_status_table( rows ) )
    output.write( `Cache TTL ${ hours( HOST_AUTH_CACHE_TTL_MS ) }; the checker re-verifies entries older than ${ hours( AUTH_CHECK_REFRESH_AFTER_MS ) } in Docker, and probes the host CLI when the last proof is ${ hours( HOST_CHECK_AFTER_MS ) } old.\n` )
    output.write( `Workspace-route agents verified at launch only: ${ workspace_route_agents().join( `, ` ) || `none` }.\n` )
    if( !scheduler ) output.write( `Scheduled checker: unsupported on this platform (run babysit auth check from your own scheduler).\n` )
    else if( scheduler.installed ) output.write( `Scheduled checker: installed (${ scheduler.label }, every 10 minutes).\n` )
    else output.write( `Scheduled checker: not installed. Run babysit auth init.\n` )
    return 0

}

// The login rode on a credential file alone. Anything else (a key in the
// launch shell, legacy entries without provenance) is invisible to the
// timer, so neither offline checks nor host probes may judge it.
const sole_file_login = entry => JSON.stringify( entry?.credential_kinds ) === `["file"]`

/**
 * Find logouts visible without a network call: a refresh token past its own
 * expiry, or a deleted credential file. Only logins whose sole recorded
 * source was that file qualify; a key in the launch shell may still log in.
 * Deletion is re-read once, so an atomic rewrite in flight is not a logout.
 *
 * @param {Object[]} agents - Enrolled adapters
 * @param {Object} options - Cache, clock, and reader seams
 * @returns {Promise<{ agent: Object, reason: string }[]>} Offline logouts
 */
export const find_offline_logouts = async ( agents, {
    cache,
    read_credential = read_host_credential,
    now = Date.now(),
    wait = sleep,
} ) => {

    const found = []

    for( const agent of agents.filter( agent => sole_file_login( cache.agents?.[ agent.name ] ) ) ) {

        const credential = read_credential( agent )
        const expires_at = credential.state === `present` ? agent.auth_check?.refresh_expires_at?.( credential.text ) : NaN

        if( expires_at <= now ) found.push( { agent, reason: `its refresh token expired` } )
        else if( credential.state === `absent` ) {
            await wait( OFFLINE_RECHECK_MS )
            if( read_credential( agent ).state === `absent` ) found.push( { agent, reason: `its credential file was deleted` } )
        }

    }

    return found

}

/**
 * Whether a host CLI probe is worth running now. The container check owns
 * logins past half the TTL; the host probe fills the hours in between.
 * @param {Object|undefined} entry - Cache entry
 * @param {number} now - Clock
 * @returns {boolean} True when the last proof of any kind is an hour old
 */
const host_probe_due = ( entry, now ) => {

    const container_at = Date.parse( entry?.authenticated_at )
    const host_at = Date.parse( entry?.host_verified_at ) || 0
    if( !Number.isFinite( container_at ) || now - container_at >= AUTH_CHECK_REFRESH_AFTER_MS ) return false
    return now - Math.max( container_at, host_at ) >= HOST_CHECK_AFTER_MS

}

/**
 * Quietly re-verify enrolled logins, cheapest evidence first:
 *
 * 1. Offline: expired refresh tokens and deleted credential files.
 * 2. Host CLI probe (seconds) once the last proof is an hour old, for logins
 *    that rode on the credential file alone. While a Babysit session runs,
 *    only when the access token is fresh enough that the probe cannot rotate
 *    a refresh token the session also holds.
 * 3. Container probe at half the cache TTL, which keeps launches warm.
 *
 * Lost logins feed the Pushover logout alerts. Yields to a foreground launch
 * that starts waiting for the lease, and skips entirely when another check or
 * launch already holds it. Signals are left to the probe launcher, which
 * retains an interrupted container for credential recovery exactly like an
 * interrupted session start.
 *
 * With an agent and `force` (a monitor saw a lost login on screen), that
 * agent is probed now: host CLI when possible, else the container. The
 * rotation guard still applies.
 *
 * @param {Object} [options] - Output and injectable seams
 * @returns {Promise<number>} Exit code; 0 unless a probe failed outright
 */
export const cmd_auth_check = async ( {
    output = process.stdout,
    agent_name = null,
    force = false,
    acquire_lease = acquire_host_auth_lease,
    is_wanted = is_host_auth_lease_wanted,
    poll_ms = AUTH_CHECK_YIELD_POLL_MS,
    select_agents = null,
    env = process.env,
    now = Date.now(),
    usage_alerts = alert_high_usage,
    logout_alerts = alert_logouts,
    read_usage = () => collect_usage( { allow_native_refresh: true } ),
    read_credential = read_host_credential,
    run_host_check = run_host_cli_auth_check,
    list_active_sessions = list_sessions,
    wait = sleep,
    ...diagnostics
} = {} ) => {

    const cache_options = diagnostics.cache_path ? { cache_path: diagnostics.cache_path } : {}
    const cache = read_host_auth_cache( cache_options )
    const agents = ( select_agents ? select_agents() : select_auth_check_agents( { cache } ) )
        .filter( agent => !agent_name || agent.name === agent_name )
    const notifying = pushover_configured( env )
    if( !agents.length && !notifying ) {
        output.write( `No previously verified agents to keep warm; launch one or run babysit doctor --auth first.\n` )
        return 0
    }

    let lease
    try {
        lease = await acquire_lease( { timeout_ms: 0, foreground: false } )
    } catch {
        output.write( `Another Babysit authentication check or launch is running; skipped.\n` )
        return 0
    }

    // run_auth_diagnostics releases the lease it is handed; otherwise we do
    let lease_handed = false
    const controller = new AbortController()
    const watcher = setInterval( () => {
        if( is_wanted() ) controller.abort( { code: `skip`, yielded: true } )
    }, poll_ms )
    watcher.unref?.()

    try {
        // Usage alerts ride the scheduled checker. Only with Pushover configured:
        // otherwise they are a no-op, so skip the provider requests too. Runs
        // first because run_auth_diagnostics releases the lease (native Codex
        // refresh needs it held). A monitor-triggered check is about one login.
        if( notifying && !agent_name ) {
            try {
                const sent = await usage_alerts( await read_usage() )
                if( sent.length ) output.write( `Usage alerts sent: ${ sent.join( `, ` ) }\n` )
            } catch ( error ) {
                output.write( `Usage check failed: ${ error.message }\n` )
            }
        }

        if( !agents.length ) {
            if( notifying ) await logout_alerts( [] )
            output.write( `No previously verified agents to keep warm; launch one or run babysit doctor --auth first.\n` )
            return 0
        }

        const login_of = name => cache.agents?.[ name ]?.authenticated_at || `unknown`
        const labelled = result => result.status === `skipped` && controller.signal.reason?.yielded
            ? { ...result, reason: `yielded to a Babysit launch` }
            : result
        const logouts = []
        const recovered = []
        const results = []

        // 1. Offline evidence
        const offline = await find_offline_logouts( agents, { cache, read_credential, now, wait } )
        for( const { agent, reason } of offline ) {
            clear_host_auth_cache( agent.name, cache_options )
            logouts.push( { agent: agent.name, login: login_of( agent.name ), reason } )
            results.push( { name: agent.name, status: `unauthenticated`, authenticated: false, reason } )
        }
        const online = agents.filter( agent => !offline.some( found => found.agent === agent ) )

        // 2. Host CLI probes, detection only. The rotation guard holds even
        // when forced: one session's dead login says nothing about another
        // session still holding a live refresh token.
        // An unreadable tmux server counts as busy: failing open would
        // let a probe rotate a token a session holds
        const sessions_active = await list_active_sessions( { strict: true } )
            .then( sessions => sessions.length > 0, () => true )
        const would_rotate = agent => {
            const credential = read_credential( agent )
            return credential.state !== `present` || !agent.auth_check?.refresh_free?.( credential.text, now )
        }
        const host_candidates = online.filter( agent => agent.auth_check?.host_args
            && sole_file_login( cache.agents?.[ agent.name ] )
            && ( force || host_probe_due( cache.agents?.[ agent.name ], now ) ) )
        const host_results = ( await Promise.all( host_candidates.map( async agent => {
            if( sessions_active && would_rotate( agent ) ) {
                return { name: agent.name, status: `deferred`, authenticated: false, reason: `a running session may be refreshing its token` }
            }
            return run_host_check( agent, { signal: controller.signal, env } )
        } ) ) ).filter( Boolean )

        for( const result of host_results ) {
            if( result.status === `authenticated` ) {
                stamp_host_verification( result.name, cache_options )
                recovered.push( result.name )
            }
            if( result.status === `unauthenticated` ) {
                clear_host_auth_cache( result.name, cache_options )
                logouts.push( { agent: result.name, login: login_of( result.name ), reason: `the host CLI reports it logged out` } )
            }
            results.push( labelled( result ) )
        }

        // 3. Container probes for everything the host could not settle
        const container_agents = online.filter( agent => !host_results.some( result => result.name === agent.name ) )
        if( container_agents.length ) {
            lease_handed = true
            const container_results = await run_auth_diagnostics( container_agents, {
                ...diagnostics,
                output,
                input: { isTTY: false },
                acquire_lease: async () => lease,
                ttl_ms: force ? 0 : AUTH_CHECK_REFRESH_AFTER_MS,
                only_with_credentials: true,
                // A network blip must not un-enrol the agent; the entry stays
                // valid until its TTL and the next run retries.
                clear_on_failure: false,
                signal: controller.signal,
            } )

            for( const result of container_results ) {
                // A cache hit matches today's credentials, so it is a login
                // verified after any logout on record
                if( [ `authenticated`, `cached` ].includes( result.status ) ) recovered.push( result.name )
                if( result.status === `unauthenticated` ) logouts.push( { agent: result.name, login: login_of( result.name ) } )
                results.push( labelled( result ) )
            }
        }

        const order = agents.map( agent => agent.name )
        results
            .sort( ( left, right ) => order.indexOf( left.name ) - order.indexOf( right.name ) )
            .forEach( result => output.write( `${ format_auth_result_line( result ) }\n` ) )

        // Alert once per lost login, retrying undelivered ones; `failed`
        // (network blips) never alerts, and a re-verified agent clears its own
        if( notifying ) {
            // A dead setup-token outranks any fresh /login: name the fix that works
            const fixed = logouts.map( logout => logout.agent === `claude` && env[ CLAUDE_TOKEN_ENV ]
                ? { ...logout, fix: `Run babysit auth init --claude-token on the host.` }
                : logout )
            const sent = await logout_alerts( fixed, { recovered } )
            if( sent.length ) output.write( `Logout alerts sent: ${ sent.join( `, ` ) }\n` )
        }

        return results.some( result => [ `failed`, `unauthenticated` ].includes( result.status ) ) ? 1 : 0
    } finally {
        clearInterval( watcher )
        if( !lease_handed ) lease.release()
    }

}

/**
 * Install or remove the scheduled checker for the invoking user. No sudo: the
 * user's own systemd instance or launchd session owns the schedule.
 *
 * @param {Object} cmd - Parsed auth command
 * @param {Object} [options] - Output and seams
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth_init = async ( cmd, {
    output = process.stdout,
    execute = run,
    scheduler = resolve_checker_scheduler(),
    command = resolve_checker_command(),
    environment = checker_environment(),
    uid = process.getuid?.(),
    home = homedir(),
    write = writeFileSync,
    remove = path => rmSync( path, { force: true } ),
    claude_token = setup_claude_token,
} = {} ) => {

    if( !scheduler ) throw new Error( `babysit auth init supports Linux hosts running systemd and macOS; schedule babysit auth check yourself elsewhere` )

    if( cmd.flags.remove ) {
        if( scheduler.kind === `systemd` ) await execute( `systemctl`, [ `--user`, `disable`, `--now`, scheduler.label ] ).catch( () => {} )
        else await execute( `launchctl`, [ `bootout`, `gui/${ uid }`, scheduler.files[0] ] ).catch( () => {} )
        scheduler.files.forEach( remove )
        if( scheduler.kind === `systemd` ) await execute( `systemctl`, [ `--user`, `daemon-reload` ] ).catch( () => {} )
        output.write( `Removed the scheduled authentication checker (${ scheduler.label }).\n` )
        return 0
    }

    mkdirSync( dirname( scheduler.files[0] ), { recursive: true } )

    if( scheduler.kind === `systemd` ) {
        const { service, timer } = render_auth_timer_units( { command, environment } )
        write( scheduler.files[0], service, { mode: 0o600 } )
        write( scheduler.files[1], timer, { mode: 0o600 } )
        await execute( `systemctl`, [ `--user`, `daemon-reload` ] )
        await execute( `systemctl`, [ `--user`, `enable`, `--now`, scheduler.label ] )
        output.write( `Enabled ${ scheduler.label }: babysit auth check runs every 10 minutes (re-run after upgrading from an hourly install).\n` )
        output.write( `Logs: journalctl --user -u ${ SYSTEMD_UNIT }.service\n` )

        // Without lingering the user manager stops at logout, and with it the
        // timer. Enable it by default; --no-linger keeps the login-only scope.
        if( cmd.flags.linger === false ) {
            output.write( `Lingering left unchanged (--no-linger): checks run only while you are logged in.\n` )
        } else {
            try {
                await execute( `loginctl`, [ `enable-linger`, String( uid ) ] )
                output.write( `Enabled lingering for your user so checks continue after logout (undo: loginctl disable-linger ${ uid }).\n` )
            } catch ( error ) {
                output.write( `Could not enable lingering (${ error.message.split( `\n` )[0] }); checks run only while you are logged in. Try: sudo loginctl enable-linger ${ uid }\n` )
            }
        }
    } else {
        const log_path = join( home, `Library`, `Logs`, `babysit-auth.log` )
        mkdirSync( dirname( log_path ), { recursive: true } )
        write( scheduler.files[0], render_auth_launch_agent( { command, environment, log_path } ), { mode: 0o600 } )
        await execute( `launchctl`, [ `bootout`, `gui/${ uid }`, scheduler.files[0] ] ).catch( () => {} )
        await execute( `launchctl`, [ `bootstrap`, `gui/${ uid }`, scheduler.files[0] ] )
        output.write( `Loaded ${ scheduler.label }: babysit auth check runs every 10 minutes (re-run after upgrading from an hourly install).\n` )
        output.write( `Logs: ${ log_path }\n` )
    }

    output.write( `Remove with: babysit auth init --remove\n` )

    // An explicitly requested token that could not be set up is a failure
    return await claude_token( cmd, { output } ) === `failed` ? 1 : 0

}

/**
 * Dispatch `babysit auth <status|check|init>`.
 * @param {Object} cmd - Parsed command
 * @param {Object} [dependencies] - Test seams forwarded to the subcommand
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth = async ( cmd, dependencies = {} ) => {

    if( cmd.auth_verb === `check` ) return cmd_auth_check( { agent_name: cmd.agent, force: Boolean( cmd.flags?.force ), ...dependencies } )
    if( cmd.auth_verb === `init` ) return cmd_auth_init( cmd, dependencies )
    return cmd_auth_status( dependencies )

}
