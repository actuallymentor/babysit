import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import {
    fingerprint_agent_credentials,
    HOST_AUTH_CACHE_TTL_MS,
    read_host_auth_cache,
    record_host_auth_success,
} from '../src/agents/auth_cache.js'
import { get_agent } from '../src/agents/index.js'
import {
    AUTH_CHECK_REFRESH_AFTER_MS,
    auth_checker_hint,
    checker_environment,
    cmd_auth_check,
    cmd_auth_init,
    cmd_auth_status,
    describe_auth_cache_entry,
    format_auth_status_table,
    render_auth_launch_agent,
    render_auth_timer_units,
    resolve_checker_scheduler,
    select_auth_check_agents,
} from '../src/cli/auth.js'

const IMAGE_IDENTITY = `sha256:auth-command-test-image`
const NOW = Date.parse( `2026-10-03T12:00:00.000Z` )

const collect_output = () => {
    const output = new PassThrough()
    let rendered = ``
    output.isTTY = false
    output.on( `data`, chunk => rendered += chunk.toString() )
    return { output, rendered: () => rendered }
}

const ENV_PUSHOVER = { PUSHOVER_TOKEN: `t`, PUSHOVER_USER: `u` }

const owned_lease = () => {
    const lease = { released: 0, release: () => lease.released += 1 }
    return lease
}

describe( `auth cache status`, () => {

    it( `describes missing, fresh, due, expired and image-stale entries`, () => {

        const cache = { version: 1, agents: {
            claude: { authenticated_at: new Date( NOW - 3_600_000 ).toISOString(), image_identity: IMAGE_IDENTITY },
            codex: { authenticated_at: new Date( NOW - AUTH_CHECK_REFRESH_AFTER_MS - 1 ).toISOString(), image_identity: IMAGE_IDENTITY },
            opencode: { authenticated_at: new Date( NOW - HOST_AUTH_CACHE_TTL_MS ).toISOString(), image_identity: IMAGE_IDENTITY },
            antigravity: { authenticated_at: new Date( NOW - 1_000 ).toISOString(), image_identity: `sha256:old` },
        } }
        const options = { image_identity: IMAGE_IDENTITY, now: NOW }

        expect( describe_auth_cache_entry( `claude`, cache, options ) ).toMatchObject( { state: `fresh`, age: `1.0h` } )
        expect( describe_auth_cache_entry( `codex`, cache, options ).state ).toBe( `due for refresh` )
        expect( describe_auth_cache_entry( `opencode`, cache, options ).state ).toBe( `expired` )
        expect( describe_auth_cache_entry( `antigravity`, cache, options ).state ).toBe( `stale image` )
        expect( describe_auth_cache_entry( `nobody`, cache, options ) ).toEqual( { name: `nobody`, verified: `-`, age: `-`, state: `missing` } )

        const table = format_auth_status_table( [ describe_auth_cache_entry( `claude`, cache, options ) ] )
        expect( table.split( `\n` )[0] ).toMatch( /^AGENT\s+VERIFIED\s+AGE\s+STATE$/ )
        expect( table ).toContain( `claude  2026-10-03 11:00:00 UTC  1.0h  fresh` )

    } )

    it( `prints the table and the scheduler state`, async () => {

        const { output, rendered } = collect_output()

        await cmd_auth_status( {
            output,
            cache_path: join( tmpdir(), `missing-babysit-cache-${ process.pid }.json` ),
            resolve_image_identity: async () => IMAGE_IDENTITY,
            scheduler: { kind: `systemd`, label: `babysit-auth.timer`, installed: false },
        } )

        expect( rendered() ).toContain( `claude` )
        expect( rendered() ).toContain( `missing` )
        expect( rendered() ).toContain( `not installed. Run babysit auth init.` )

    } )

} )

describe( `auth check`, () => {

    let directory
    let cache_path
    let mounts

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-auth-check-` ) )
        cache_path = join( directory, `auth-cache.json` )
        mounts = [ { type: `secret_env`, key: `CODEX_API_KEY`, value: `check-test-key` } ]
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    const check = ( overrides = {} ) => {
        const { output, rendered } = collect_output()
        const lease = owned_lease()
        const probes = []
        const exit_code = cmd_auth_check( {
            output,
            cache_path,
            setup: async () => ( { mounts, sync: null, tmpfiles: {} } ),
            resolve_image_identity: async () => IMAGE_IDENTITY,
            resolve_context_files: () => ( {} ),
            acquire_lease: async () => lease,
            is_wanted: () => false,
            select_agents: () => [ get_agent( `codex` ), get_agent( `claude` ) ],
            run_auth_check: async agent => {
                probes.push( agent.name )
                return { name: agent.name, status: `authenticated`, authenticated: true }
            },
            ...overrides,
        } )
        return { exit_code, rendered, lease, probes }
    }

    it( `alerts once for a verified agent that is now logged out, and on high usage`, async () => {

        const logouts = []
        const usage_runs = []
        const { exit_code, rendered, lease } = check( {
            env: { PUSHOVER_TOKEN: `t`, PUSHOVER_USER: `u` },
            read_usage: async () => ( { agents: [] } ),
            usage_alerts: async usage => {
                usage_runs.push( usage )
                return [ `claude/anthropic/weekly` ]
            },
            logout_alerts: async found => {
                logouts.push( ...found.map( logout => logout.agent ) )
                return found.map( logout => logout.agent )
            },
            run_auth_check: async agent => agent.name === `codex`
                ? { name: `codex`, status: `unauthenticated`, authenticated: false, reason: `401` }
                : { name: agent.name, status: `failed`, authenticated: false, reason: `network` },
        } )

        expect( await exit_code ).toBe( 1 )
        expect( usage_runs ).toEqual( [ { agents: [] } ] )
        expect( rendered() ).toContain( `Usage alerts sent: claude/anthropic/weekly` )
        expect( rendered() ).toContain( `Logout alerts sent: codex` )
        // A failed probe is a blip, not a logout
        expect( logouts ).toEqual( [ `codex` ] )
        expect( lease.released ).toBe( 1 )

    } )

    it( `skips usage without Pushover, and checks it with Pushover even when no agent needs warming`, async () => {

        let usage_reads = 0
        const read_usage = async () => {
            usage_reads += 1
            return { agents: [] }
        }

        const silent = check( { select_agents: () => [], read_usage } )
        expect( await silent.exit_code ).toBe( 0 )
        expect( usage_reads ).toBe( 0 )
        expect( silent.lease.released ).toBe( 0 )

        const notifying = check( { select_agents: () => [], read_usage, env: ENV_PUSHOVER, usage_alerts: async () => [], logout_alerts: async () => [] } )
        expect( await notifying.exit_code ).toBe( 0 )
        expect( usage_reads ).toBe( 1 )
        expect( notifying.lease.released ).toBe( 1 )

    } )

    it( `skips when another launch or check already holds the lease`, async () => {

        const { exit_code, rendered, probes } = check( {
            acquire_lease: async () => {
                throw new Error( `Timed out waiting for another authentication check` )
            },
        } )

        expect( await exit_code ).toBe( 0 )
        expect( rendered() ).toContain( `skipped` )
        expect( probes ).toEqual( [] )

    } )

    it( `probes only agents with staged credentials whose entry is missing or past half its TTL`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: Date.now() - 1_000 } )

        const fresh = check()
        expect( await fresh.exit_code ).toBe( 0 )
        expect( fresh.probes ).toEqual( [] )
        expect( fresh.rendered() ).toContain( `codex: cached` )
        expect( fresh.rendered() ).toContain( `claude: no credentials` )
        expect( fresh.lease.released ).toBe( 1 )

        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: Date.now() - AUTH_CHECK_REFRESH_AFTER_MS - 1_000 } )

        const due = check()
        expect( await due.exit_code ).toBe( 0 )
        expect( due.probes ).toEqual( [ `codex` ] )
        expect( due.rendered() ).toContain( `codex: authenticated` )
        const refreshed = Date.parse( read_host_auth_cache( { cache_path } ).agents.codex.authenticated_at )
        expect( Date.now() - refreshed ).toBeLessThan( 60_000 )

    } )

    it( `yields to a waiting foreground launch without clearing the cache`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: Date.now() - HOST_AUTH_CACHE_TTL_MS + 60_000 } )
        let wanted = false

        const { exit_code, rendered, lease } = check( {
            poll_ms: 1,
            is_wanted: () => wanted,
            run_auth_check: ( agent, { signal } ) => new Promise( resolve => {
                wanted = true
                signal.addEventListener( `abort`, () => resolve( {
                    name: agent.name,
                    status: `skipped`,
                    authenticated: false,
                } ) )
            } ),
        } )

        expect( await exit_code ).toBe( 0 )
        expect( rendered() ).toContain( `codex: skipped (yielded to a Babysit launch)` )
        expect( read_host_auth_cache( { cache_path } ).agents.codex ).toBeDefined()
        expect( lease.released ).toBe( 1 )

    } )

    it( `keeps warm only previously authenticated agents without workspace-specific routes`, () => {

        const names = agents => agents.map( agent => agent.name )
        const cache = { version: 1, agents: {
            opencode: { authenticated_at: new Date().toISOString() },
            claude: { authenticated_at: `2020-01-01T00:00:00.000Z` },
            codex: { authenticated_at: `2020-01-01T00:00:00.000Z` },
        } }

        // OpenCode's identity includes the launching project's route; a
        // scheduler-side probe would replace that entry with its own.
        expect( names( select_auth_check_agents( { cache } ) ) ).toEqual( [ `claude`, `codex` ] )
        expect( names( select_auth_check_agents( { cache: { version: 1, agents: {} } } ) ) ).toEqual( [] )

    } )

    it( `keeps a still-valid entry when a probe fails for a non-auth reason`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: Date.now() - AUTH_CHECK_REFRESH_AFTER_MS - 1_000 } )

        const { exit_code, rendered } = check( {
            run_auth_check: async agent => ( { name: agent.name, status: `failed`, authenticated: false, reason: `timed out` } ),
        } )

        expect( await exit_code ).toBe( 1 )
        expect( rendered() ).toContain( `codex: failed (timed out)` )
        expect( read_host_auth_cache( { cache_path } ).agents.codex ).toBeDefined()

    } )

    it( `does nothing when no agent was verified before`, async () => {

        const { exit_code, rendered, probes } = check( { select_agents: () => [] } )

        expect( await exit_code ).toBe( 0 )
        expect( rendered() ).toContain( `No previously verified agents` )
        expect( probes ).toEqual( [] )

    } )

    it( `reports a real failure through the exit code`, async () => {

        const { exit_code, rendered } = check( {
            run_auth_check: async agent => ( { name: agent.name, status: `unauthenticated`, authenticated: false, reason: `401` } ),
        } )

        expect( await exit_code ).toBe( 1 )
        expect( rendered() ).toContain( `codex: unauthenticated (401)` )
        expect( read_host_auth_cache( { cache_path } ).agents.codex ).toBeUndefined()

    } )

} )

describe( `auth checker hint`, () => {

    const probed = [ { name: `claude`, status: `authenticated`, authenticated: true } ]
    const cached = [ { name: `claude`, status: `cached`, authenticated: true } ]

    it( `nudges only after a real probe on a host without the checker`, () => {

        expect( auth_checker_hint( probed, { scheduler: { installed: false } } ) ).toContain( `babysit auth init` )
        expect( auth_checker_hint( cached, { scheduler: { installed: false } } ) ).toBeNull()
        expect( auth_checker_hint( probed, { scheduler: { installed: true } } ) ).toBeNull()
        expect( auth_checker_hint( probed, { scheduler: null } ) ).toBeNull()

    } )

} )

describe( `scheduled checker installation`, () => {

    const command = [ `/opt/babysit/babysit` ]

    it( `renders a systemd user timer pair that runs auth check hourly`, () => {

        const { service, timer } = render_auth_timer_units( { command, environment: { PATH: `/usr/bin:/bin`, BABYSIT_HOME: `/mnt/state 100%` } } )

        expect( service ).toContain( `Type=oneshot` )
        expect( service ).toContain( `ExecStart="/opt/babysit/babysit" auth check` )
        expect( service ).toContain( `Environment="PATH=/usr/bin:/bin"` )
        expect( service ).toContain( `Environment="BABYSIT_HOME=/mnt/state 100%%"` )
        expect( timer ).toContain( `OnUnitActiveSec=3600` )
        expect( timer ).toContain( `Persistent=true` )
        expect( timer ).toContain( `WantedBy=timers.target` )
        expect( () => render_auth_timer_units( { command: [ `babysit` ] } ) ).toThrow( `absolute` )

    } )

    it( `renders a launchd agent with the same schedule`, () => {

        const plist = render_auth_launch_agent( { command, environment: { PATH: `/usr/local/bin` }, log_path: `/Users/a/Library/Logs/babysit-auth.log` } )

        expect( plist ).toContain( `<string>dev.babysit.auth</string>` )
        expect( plist ).toContain( `<string>/opt/babysit/babysit</string>\n        <string>auth</string>\n        <string>check</string>` )
        expect( plist ).toContain( `<key>StartInterval</key>\n    <integer>3600</integer>` )
        expect( plist ).toContain( `<key>PATH</key>\n        <string>/usr/local/bin</string>` )

    } )

    it( `carries only the launch-relevant environment`, () => {

        expect( checker_environment( { PATH: `/bin`, DOCKER_HOST: `unix:///run/user/1000/docker.sock`, BABYSIT_DOCKER_USE_SUDO: `1`, SECRET: `x`, HOME: `/home/a` } ) )
            .toEqual( { PATH: `/bin`, BABYSIT_DOCKER_USE_SUDO: `1`, DOCKER_HOST: `unix:///run/user/1000/docker.sock` } )
        expect( checker_environment( { PATH: `/bin`, PUSHOVER_TOKEN: `t`, PUSHOVER_USER: `u` } ) )
            .toEqual( { PATH: `/bin`, PUSHOVER_TOKEN: `t`, PUSHOVER_USER: `u` } )

    } )

    it( `picks the scheduler by platform`, () => {

        expect( resolve_checker_scheduler( { platform: `linux`, home: `/home/a`, exists: () => true } ) ).toMatchObject( {
            kind: `systemd`,
            label: `babysit-auth.timer`,
            installed: true,
        } )
        expect( resolve_checker_scheduler( { platform: `darwin`, home: `/Users/a`, exists: () => false } ) ).toMatchObject( {
            kind: `launchd`,
            files: [ `/Users/a/Library/LaunchAgents/dev.babysit.auth.plist` ],
            installed: false,
        } )
        expect( resolve_checker_scheduler( { platform: `linux`, exists: () => false } ) ).toBeNull()
        expect( resolve_checker_scheduler( { platform: `win32` } ) ).toBeNull()

    } )

    it( `installs and removes the systemd timer through the user manager`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-auth-init-` ) )
        const calls = []
        const written = {}
        const scheduler = {
            kind: `systemd`,
            label: `babysit-auth.timer`,
            files: [ join( directory, `babysit-auth.service` ), join( directory, `babysit-auth.timer` ) ],
        }
        const { output, rendered } = collect_output()

        try {
            await cmd_auth_init( { flags: {} }, {
                output,
                scheduler,
                command,
                environment: { PATH: `/bin` },
                uid: 1000,
                execute: async ( binary, args ) => {
                    calls.push( [ binary, ...args ] )
                    return `yes`
                },
                write: ( path, content ) => {
                    written[ path ] = content
                },
            } )

            expect( Object.keys( written ) ).toEqual( scheduler.files )
            expect( calls ).toEqual( [
                [ `systemctl`, `--user`, `daemon-reload` ],
                [ `systemctl`, `--user`, `enable`, `--now`, `babysit-auth.timer` ],
                [ `loginctl`, `enable-linger`, `1000` ],
            ] )
            expect( rendered() ).toContain( `Enabled babysit-auth.timer` )
            expect( rendered() ).toContain( `Enabled lingering` )

            calls.length = 0
            await cmd_auth_init( { flags: { linger: false } }, {
                output,
                scheduler,
                command,
                environment: { PATH: `/bin` },
                uid: 1000,
                execute: async ( binary, args ) => {
                    calls.push( [ binary, ...args ] )
                    return ``
                },
                write: () => {},
            } )
            expect( calls.some( call => call.includes( `enable-linger` ) ) ).toBe( false )
            expect( rendered() ).toContain( `Lingering left unchanged (--no-linger)` )

            calls.length = 0
            await cmd_auth_init( { flags: {} }, {
                output,
                scheduler,
                command,
                environment: { PATH: `/bin` },
                uid: 1000,
                execute: async ( binary, args ) => {
                    if( binary === `loginctl` ) throw new Error( `Access denied\nmore` )
                    calls.push( [ binary, ...args ] )
                    return ``
                },
                write: () => {},
            } )
            expect( rendered() ).toContain( `Could not enable lingering (Access denied)` )

            calls.length = 0
            const removed = []
            await cmd_auth_init( { flags: { remove: true } }, {
                output,
                scheduler,
                uid: 1000,
                execute: async ( binary, args ) => {
                    calls.push( [ binary, ...args ] )
                    return ``
                },
                remove: path => removed.push( path ),
            } )

            expect( calls[0] ).toEqual( [ `systemctl`, `--user`, `disable`, `--now`, `babysit-auth.timer` ] )
            expect( removed ).toEqual( scheduler.files )
            expect( rendered() ).toContain( `Removed the scheduled authentication checker` )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `refuses platforms without a supported scheduler`, async () => {

        await expect( cmd_auth_init( { flags: {} }, { scheduler: null } ) ).rejects.toThrow( `supports Linux hosts running systemd and macOS` )

    } )

} )
