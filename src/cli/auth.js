import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import {
    HOST_AUTH_CACHE_TTL_MS,
    read_host_auth_cache,
    resolve_auth_image_identity,
} from '../agents/auth_cache.js'
import { acquire_host_auth_lease, is_host_auth_lease_wanted } from '../agents/auth_lease.js'
import { run } from '../utils/exec.js'
import { format_auth_result_line, run_auth_diagnostics } from './doctor.js'
import { unit_quote } from './recover_init.js'

// The checker runs hourly and re-probes once an entry is past half its TTL,
// so a launch always finds a success that still has hours of life left.
export const AUTH_CHECK_INTERVAL_S = 60 * 60
export const AUTH_CHECK_REFRESH_AFTER_MS = HOST_AUTH_CACHE_TTL_MS / 2
export const AUTH_CHECK_YIELD_POLL_MS = 250

const SYSTEMD_UNIT = `babysit-auth`
const LAUNCHD_LABEL = `dev.babysit.auth`

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
    [ `PATH`, `BABYSIT_HOME`, `BABYSIT_DOCKER_IMAGE`, `BABYSIT_DOCKER_USE_SUDO`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR` ]
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
Description=Hourly Babysit authentication cache refresh

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
    output.write( `Cache TTL ${ hours( HOST_AUTH_CACHE_TTL_MS ) }; the checker re-verifies entries older than ${ hours( AUTH_CHECK_REFRESH_AFTER_MS ) }.\n` )
    output.write( `Workspace-route agents verified at launch only: ${ workspace_route_agents().join( `, ` ) || `none` }.\n` )
    if( !scheduler ) output.write( `Scheduled checker: unsupported on this platform (run babysit auth check from your own scheduler).\n` )
    else if( scheduler.installed ) output.write( `Scheduled checker: installed (${ scheduler.label }, hourly).\n` )
    else output.write( `Scheduled checker: not installed. Run babysit auth init.\n` )
    return 0

}

/**
 * Quietly re-verify logins the next launch would otherwise probe. Yields to a
 * foreground launch that starts waiting for the lease, and skips entirely
 * when another check or launch already holds it. Signals are left to the
 * probe launcher, which retains an interrupted container for credential
 * recovery exactly like an interrupted session start.
 *
 * @param {Object} [options] - Output and injectable seams
 * @returns {Promise<number>} Exit code; 0 unless a probe failed outright
 */
export const cmd_auth_check = async ( {
    output = process.stdout,
    acquire_lease = acquire_host_auth_lease,
    is_wanted = is_host_auth_lease_wanted,
    poll_ms = AUTH_CHECK_YIELD_POLL_MS,
    select_agents = null,
    ...diagnostics
} = {} ) => {

    const cache = read_host_auth_cache( diagnostics.cache_path ? { cache_path: diagnostics.cache_path } : {} )
    const agents = select_agents ? select_agents() : select_auth_check_agents( { cache } )
    if( !agents.length ) {
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

    const controller = new AbortController()
    const watcher = setInterval( () => {
        if( is_wanted() ) controller.abort( { code: `skip`, yielded: true } )
    }, poll_ms )
    watcher.unref?.()

    try {
        const results = await run_auth_diagnostics( agents, {
            ...diagnostics,
            output,
            input: { isTTY: false },
            acquire_lease: async () => lease,
            ttl_ms: AUTH_CHECK_REFRESH_AFTER_MS,
            only_with_credentials: true,
            // A network blip must not un-enrol the agent; the entry stays
            // valid until its TTL and the next hourly run retries.
            clear_on_failure: false,
            signal: controller.signal,
        } )

        results.forEach( result => output.write( `${ format_auth_result_line(
            result.status === `skipped` && controller.signal.reason?.yielded
                ? { ...result, reason: `yielded to a Babysit launch` }
                : result
        ) }\n` ) )

        return results.some( result => [ `failed`, `unauthenticated` ].includes( result.status ) ) ? 1 : 0
    } finally {
        // run_auth_diagnostics releases the lease it was handed.
        clearInterval( watcher )
    }

}

/**
 * Install or remove the hourly checker for the invoking user. No sudo: the
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
        output.write( `Enabled ${ scheduler.label }: babysit auth check runs hourly while you are logged in.\n` )
        output.write( `Logs: journalctl --user -u ${ SYSTEMD_UNIT }.service\n` )

        // Without lingering the user manager stops at logout, and with it the timer.
        const linger = await execute( `loginctl`, [ `show-user`, String( uid ), `--property=Linger`, `--value` ] ).catch( () => `unknown` )
        if( linger.trim() === `no` ) output.write( `To keep checking after logout: loginctl enable-linger ${ process.env.USER || uid }\n` )
    } else {
        const log_path = join( home, `Library`, `Logs`, `babysit-auth.log` )
        mkdirSync( dirname( log_path ), { recursive: true } )
        write( scheduler.files[0], render_auth_launch_agent( { command, environment, log_path } ), { mode: 0o600 } )
        await execute( `launchctl`, [ `bootout`, `gui/${ uid }`, scheduler.files[0] ] ).catch( () => {} )
        await execute( `launchctl`, [ `bootstrap`, `gui/${ uid }`, scheduler.files[0] ] )
        output.write( `Loaded ${ scheduler.label }: babysit auth check runs hourly.\n` )
        output.write( `Logs: ${ log_path }\n` )
    }

    output.write( `Remove with: babysit auth init --remove\n` )
    return 0

}

/**
 * Dispatch `babysit auth <status|check|init>`.
 * @param {Object} cmd - Parsed command
 * @param {Object} [dependencies] - Test seams forwarded to the subcommand
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth = async ( cmd, dependencies = {} ) => {

    if( cmd.auth_verb === `check` ) return cmd_auth_check( dependencies )
    if( cmd.auth_verb === `init` ) return cmd_auth_init( cmd, dependencies )
    return cmd_auth_status( dependencies )

}
