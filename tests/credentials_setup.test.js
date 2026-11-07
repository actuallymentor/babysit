import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

import { get_agent } from '../src/agents/index.js'
import { aggregate_syncs, setup_credentials } from '../src/credentials/index.js'
import { setup_agent_credentials } from '../src/credentials/setup.js'
import { hash_credential_content, start_credential_sync } from '../src/credentials/refresh.js'

// Regression suite for the monitor-tmpfile fix.
//
// The bug: cmd_monitor was calling `setup_credentials(agent)` with no options,
// which minted a brand-new sync file. The container had been staged from the
// foreground's file, so the monitor watched the wrong local observation point.
// Container-side OAuth refreshes never made it back to the host
// auth.json, and the next babysit session failed with "refresh token already
// used" the moment the agent started.
//
// Fix: setup_credentials now accepts `{ existing_tmpfile }`, and cmd_monitor
// passes session.creds_tmpfile and container_id so its sync watches the SAME
// local file and Docker container.

describe( `aggregate credential sync`, () => {

    it( `pulls a fast-exit rotation after the launch transport connects`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-fast-exit-sync-test-` ) )
        const source = join( directory, `host-auth.json` )
        const tmpfile = join( directory, `sync-auth.json` )
        const initial = `{"refresh_token":"initial"}`
        const rotated = `{"refresh_token":"rotated-before-running"}`

        try {
            writeFileSync( source, initial )
            writeFileSync( tmpfile, initial )

            const controller = start_credential_sync(
                async () => readFileSync( source, `utf-8` ),
                tmpfile,
                async content => writeFileSync( source, content )
            )
            const sync = aggregate_syncs( [ {
                controller,
                name: `codex`,
                target: `/home/node/.codex/auth.json`,
            } ], {
                create_transport: () => ( {
                    pull: async path => writeFileSync( path, rotated ),
                    push: async () => {},
                } ),
            } )

            // cmd_start performs this connection before it starts the tmux
            // pane, so stop() can still pull from a container that exits too
            // quickly for await_started() to observe it running.
            sync.connect( `container-id` )
            await sync.stop()

            expect( readFileSync( source, `utf-8` ) ).toBe( rotated )
            expect( sync.baselines().codex ).toEqual( {
                baseline_source_hash: hash_credential_content( rotated ),
                baseline_tmpfile_hash: hash_credential_content( rotated ),
            } )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `reconciles a probe rotation before the session controller stops`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-probe-sync-test-` ) )
        const source = join( directory, `host-auth.json` )
        const tmpfile = join( directory, `sync-auth.json` )

        try {
            writeFileSync( source, `before` )
            writeFileSync( tmpfile, `before` )
            const controller = start_credential_sync(
                async () => readFileSync( source, `utf-8` ),
                tmpfile,
                async content => writeFileSync( source, content )
            )

            writeFileSync( tmpfile, `after-probe` )
            await controller.flush()

            expect( readFileSync( source, `utf-8` ) ).toBe( `after-probe` )
            await controller.stop()
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `waits for every final flush before reporting a failure`, async () => {

        let slow_flush_completed = false
        const sync = aggregate_syncs( [
            {
                controller: {
                    stop: async () => {
                        await new Promise( resolve => setTimeout( resolve, 2 ) )
                        slow_flush_completed = true
                    },
                },
            },
            {
                controller: {
                    stop: async () => {
                        throw new Error( `flush failed` )
                    },
                },
            },
        ] )

        await expect( sync.stop() ).rejects.toThrow( `flush failed` )
        expect( slow_flush_completed ).toBe( true )

    } )

    it( `reports host credential replacement per agent`, () => {

        const sync = aggregate_syncs( [
            {
                name: `codex`,
                controller: { source_changed: () => false },
            },
            {
                name: `claude`,
                controller: { source_changed: () => true },
            },
        ] )

        expect( sync.source_changed( `codex` ) ).toBe( false )
        expect( sync.source_changed( `claude` ) ).toBe( true )
        expect( sync.source_changed() ).toBe( true )

    } )

} )

describe( `setup_agent_credentials Keychain sources`, () => {

    it( `uses the foreground baseline instead of overwriting a refreshed container credential`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-keychain-handoff-test-` ) )
        const tmpfile = join( directory, `auth.json` )
        const keychain_credential = `{"refresh_token":"keychain-original"}`
        const container_credential = `{"refresh_token":"container-refreshed"}`
        const initial_hash = hash_credential_content( keychain_credential )
        const fake_agent = {
            name: `claude`,
            bin: `claude`,
            credentials: {
                sources: { darwin: [ { keychain: `Claude Code-credentials` } ] },
            },
            container_paths: { creds: `/home/node/.claude/.credentials.json` },
        }
        try {
            writeFileSync( tmpfile, container_credential )

            const result = setup_agent_credentials( fake_agent, {
                platform: `darwin`,
                existing_tmpfile: tmpfile,
                sync_baseline: {
                    baseline_source_hash: initial_hash,
                    baseline_tmpfile_hash: initial_hash,
                },
                read_keychain: () => ( { state: `present`, text: keychain_credential } ),
            } )

            await result.sync.stop()

            expect( readFileSync( tmpfile, `utf-8` ) ).toBe( container_credential )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    it( `captures a fresh Keychain item with one shell-free read`, async () => {

        const reads = []
        const result = setup_agent_credentials( {
            name: `claude`,
            bin: `claude`,
            credentials: { sources: { darwin: [ { keychain: `Claude Code-credentials` } ] } },
            container_paths: { creds: `/home/node/.claude/.credentials.json` },
        }, {
            platform: `darwin`,
            read_keychain: source => reads.push( source.keychain ) && { state: `present`, text: `{"refresh_token":"held"}` },
        } )

        try {
            expect( reads ).toEqual( [ `Claude Code-credentials` ] )
            expect( readFileSync( result.mounts[0].source, `utf-8` ) ).toBe( `{"refresh_token":"held"}` )
        } finally {
            await result.sync.stop()
            rmSync( result.cleanup_path, { recursive: true, force: true } )
        }

    } )

} )

describe( `setup_agent_credentials source order and flags`, () => {

    let dir
    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-creds-order-` ) )
    } )
    afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

    const agent = ( credentials ) => ( {
        name: `fake`,
        container_paths: { creds: `/home/node/.fake/auth.json` },
        credentials,
    } )

    it( `falls through a missing or locked Keychain item to the next file source`, async () => {

        const file = join( dir, `auth.json` )
        writeFileSync( file, `{"from":"file"}` )
        const fake = agent( { sources: { darwin: [ { keychain: `svc` }, { file } ] } } )

        for( const state of [ `missing`, `unknown` ] ) {
            const result = setup_agent_credentials( fake, { platform: `darwin`, read_keychain: () => ( { state } ) } )
            expect( readFileSync( result.mounts[0].source, `utf-8` ) ).toBe( `{"from":"file"}` )
            expect( result.sync_baseline.credential_source ).toBeUndefined()
            await result.sync.stop()
            rmSync( result.cleanup_path, { recursive: true, force: true } )
        }

    } )

    it( `reattaches a monitor to the source kind the foreground captured`, async () => {

        const file = join( dir, `auth.json` )
        const tmpfile = join( dir, `sync.json` )
        writeFileSync( file, `{"from":"file"}` )
        writeFileSync( tmpfile, `{"from":"keychain"}` )
        const fake = agent( { sources: { darwin: [ { keychain: `svc` }, { file } ] } } )
        const reads = []

        const result = setup_agent_credentials( fake, {
            platform: `darwin`,
            existing_tmpfile: tmpfile,
            sync_baseline: { credential_source: `keyring` },
            read_keychain: () => reads.push( `read` ) && { state: `present`, text: `{"from":"keychain"}` },
        } )

        expect( result.mounts ).toEqual( [] )
        expect( result.sync_baseline.credential_source ).toBe( `keyring` )
        // Keychain sync is one-way: a container change never reaches the host file
        writeFileSync( tmpfile, `{"from":"container"}` )
        await result.sync.stop()
        expect( readFileSync( file, `utf-8` ) ).toBe( `{"from":"file"}` )
        expect( reads.length ).toBeGreaterThan( 0 )

    } )

    it( `file_required: absence is logout, other read errors keep recovery state`, async () => {

        const file = join( dir, `auth.json` )
        writeFileSync( file, `{"tokens":{}}` )
        const required = setup_agent_credentials( agent( { sources: { linux: [ { file } ] }, file_required: true } ), { platform: `linux` } )
        const optional = setup_agent_credentials( agent( { sources: { linux: [ { file } ] } } ), { platform: `linux` } )

        rmSync( file )
        mkdirSync( file )
        await expect( required.sync.flush() ).rejects.toThrow()
        await optional.sync.flush()

        rmSync( file, { recursive: true } )
        await required.sync.stop()
        expect( required.sync.source_changed() ).toBe( true )
        await optional.sync.stop()
        rmSync( required.cleanup_path, { recursive: true, force: true } )
        rmSync( optional.cleanup_path, { recursive: true, force: true } )

    } )

    it( `stacks an env key on the file login and falls back to the fallback variable`, () => {

        const fake = agent( { sources: { linux: [] }, env_key: `KEY`, fallback_env: `FALLBACK` } )
        expect( setup_agent_credentials( fake, { platform: `linux`, env: { KEY: `k`, FALLBACK: `f` } } ).mounts )
            .toEqual( [ { type: `env`, key: `KEY`, value: `k` } ] )
        expect( setup_agent_credentials( fake, { platform: `linux`, env: { FALLBACK: `f` } } ).mounts )
            .toEqual( [ { type: `env`, key: `KEY`, value: `f` } ] )
        expect( setup_agent_credentials( agent( {} ), { platform: `linux` } ).mounts ).toEqual( [] )

    } )

} )

describe( `setup_agent_credentials file sources`, () => {

    let dir
    let original_home
    const fake_agent = {
        name: `codex-test`,
        bin: `codex-test`,
        credentials: {
            sources: { linux: [ { file: `~/.codex/auth.json` } ] },
        },
        container_paths: { creds: `/home/node/.codex/auth.json` },
    }

    beforeEach( () => {

        dir = mkdtempSync( join( tmpdir(), `babysit-creds-setup-` ) )
        mkdirSync( join( dir, `.codex` ) )
        writeFileSync( join( dir, `.codex/auth.json` ), `{"refresh_token":"original"}` )

        original_home = process.env.HOME
        process.env.HOME = dir

    } )

    afterEach( () => {
        process.env.HOME = original_home
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `creates a fresh tmpfile + mount on the foreground call`, async () => {

        const { mounts, sync, cleanup_path } = setup_agent_credentials( fake_agent, { platform: `linux` } )

        const volume = mounts.find( m => m.type === `synced_file` )

        expect( volume ).toBeDefined()
        expect( volume.target ).toBe( `/home/node/.codex/auth.json` )
        expect( existsSync( volume.source ) ).toBe( true )
        expect( readFileSync( volume.source, `utf-8` ) ).toBe( `{"refresh_token":"original"}` )
        expect( statSync( dirname( volume.source ) ).mode & 0o777 ).toBe( 0o700 )
        expect( statSync( volume.source ).mode & 0o777 ).toBe( 0o666 )

        await sync.stop()
        rmSync( cleanup_path, { recursive: true, force: true } )
        expect( existsSync( cleanup_path ) ).toBe( false )

    } )

    it( `re-uses the existing tmpfile when passed — no new file, no new mount`, async () => {

        // Foreground path
        const fg = setup_agent_credentials( fake_agent, { platform: `linux` } )
        const fg_tmpfile = fg.mounts.find( m => m.type === `synced_file` ).source

        // Monitor path: same agent, but pass the foreground's tmpfile
        const mon = setup_agent_credentials( fake_agent, { platform: `linux`, existing_tmpfile: fg_tmpfile } )

        // Monitor must not add a new volume mount — the container is already
        // mounting the foreground's tmpfile.
        expect( mon.mounts.find( m => m.type === `volume` ) ).toBeUndefined()
        expect( mon.sync ).not.toBeNull()

        // The monitor's sync must propagate tmpfile changes back to the host
        // file. Simulate an in-container OAuth refresh: rewrite the FOREGROUND
        // tmpfile (the same one the container is mounting) and call stop() so
        // the final tick fires.
        writeFileSync( fg_tmpfile, `{"refresh_token":"rotated"}` )
        await mon.sync.stop()

        expect( readFileSync( join( dir, `.codex/auth.json` ), `utf-8` ) )
            .toBe( `{"refresh_token":"rotated"}` )

        await fg.sync.stop()
        rmSync( fg.cleanup_path, { recursive: true, force: true } )

    } )

    it( `preserves a tmpfile rotation that happened before the monitor starts`, async () => {

        const fg = setup_agent_credentials( fake_agent, { platform: `linux` } )
        const fg_tmpfile = fg.mounts.find( m => m.type === `synced_file` ).source

        // Simulate codex refreshing during startup before the detached monitor
        // has established its credential sync. The monitor receives the
        // foreground capture baseline through session metadata, so it knows
        // the host file is stale and the tmpfile is fresh.
        writeFileSync( fg_tmpfile, `{"refresh_token":"startup-rotated"}` )

        const mon = setup_agent_credentials( fake_agent, {
            platform: `linux`,
            existing_tmpfile: fg_tmpfile,
            sync_baseline: fg.sync_baseline,
        } )

        await mon.sync.stop()

        expect( readFileSync( join( dir, `.codex/auth.json` ), `utf-8` ) )
            .toBe( `{"refresh_token":"startup-rotated"}` )
        expect( readFileSync( fg_tmpfile, `utf-8` ) )
            .toBe( `{"refresh_token":"startup-rotated"}` )

        await fg.sync.stop()
        rmSync( fg.cleanup_path, { recursive: true, force: true } )

    } )

    it( `with existing_tmpfile, host-file changes still flow to the tmpfile (direction 1)`, async () => {

        const fg = setup_agent_credentials( fake_agent, { platform: `linux` } )
        const fg_tmpfile = fg.mounts.find( m => m.type === `synced_file` ).source

        const mon = setup_agent_credentials( fake_agent, { platform: `linux`, existing_tmpfile: fg_tmpfile } )

        // Stop the foreground's sync so only the monitor's sync is watching —
        // otherwise both syncs race on the same tmpfile and the test gets noisy.
        await fg.sync.stop()

        // User re-auths on the host (rare). Direction 1 of the sync should push
        // the new content into the tmpfile so the container picks it up.
        writeFileSync( join( dir, `.codex/auth.json` ), `{"refresh_token":"reauthed"}` )

        // A host change only flows once the container transport is attached.
        mon.sync.set_transport( { push: async () => {}, pull: async () => {} } )
        await mon.sync.stop()

        expect( readFileSync( fg_tmpfile, `utf-8` ) ).toBe( `{"refresh_token":"reauthed"}` )

        rmSync( fg.cleanup_path, { recursive: true, force: true } )

    } )

} )

describe( `setup_credentials multi-agent capture`, () => {

    let dir
    let original_home
    let original_codex_home
    let original_codex_api_key
    let original_openai_api_key

    const credential_paths = {
        claude: `.claude/.credentials.json`,
        codex: `.codex/auth.json`,
        opencode: `.local/share/opencode/auth.json`,
    }

    const container_targets = {
        claude: `/home/node/.claude/.credentials.json`,
        codex: `/home/node/.codex/auth.json`,
        opencode: `/home/node/.local/share/opencode/auth.json`,
    }

    const host_credential_path = ( agent_name ) => join( dir, credential_paths[ agent_name ] )

    const seed_host_credentials = () => {

        mkdirSync( join( dir, `.claude` ), { recursive: true } )
        mkdirSync( join( dir, `.codex` ), { recursive: true } )
        mkdirSync( join( dir, `.local/share/opencode` ), { recursive: true } )

        for( const [ agent_name, relative_path ] of Object.entries( credential_paths ) ) {
            writeFileSync( join( dir, relative_path ), `{"agent":"${ agent_name }","refresh_token":"original"}` )
        }

    }

    beforeEach( () => {

        dir = mkdtempSync( join( tmpdir(), `babysit-creds-all-` ) )
        seed_host_credentials()

        original_home = process.env.HOME
        original_codex_home = process.env.CODEX_HOME
        original_codex_api_key = process.env.CODEX_API_KEY
        original_openai_api_key = process.env.OPENAI_API_KEY

        process.env.HOME = dir
        delete process.env.CODEX_HOME
        delete process.env.CODEX_API_KEY
        delete process.env.OPENAI_API_KEY

    } )

    afterEach( () => {

        process.env.HOME = original_home

        if( original_codex_home === undefined ) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = original_codex_home

        if( original_codex_api_key === undefined ) delete process.env.CODEX_API_KEY
        else process.env.CODEX_API_KEY = original_codex_api_key

        if( original_openai_api_key === undefined ) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = original_openai_api_key

        rmSync( dir, { recursive: true, force: true } )

    } )

    it( `captures credential mounts for every supported agent on a codex launch`, async () => {

        const result = await setup_credentials( get_agent( `codex` ) )
        const volume_targets = result.mounts
            .filter( mount => mount.type === `synced_file` )
            .map( mount => mount.target )

        expect( volume_targets.sort() ).toEqual( [ container_targets.opencode, container_targets.codex ].sort() )
        expect( Object.keys( result.tmpfiles ).sort() ).toEqual( [ `codex`, `opencode` ] )
        expect( Object.keys( result.sync_baselines ).sort() ).toEqual( [ `codex`, `opencode` ] )
        expect( result.creds_tmpfile ).toBeUndefined()

        await result.sync.stop()
        result.sync.cleanup()
        expect( Object.values( result.tmpfiles ).every( path => !existsSync( path ) ) ).toBe( true )

    } )

    it( `never stages Claude's host /login or env token; the setup-token rides the account env file`, async () => {

        process.env.CLAUDE_CODE_OAUTH_TOKEN = `sk-ant-oat01-test`

        try {
            const result = await setup_credentials( get_agent( `claude` ) )
            expect( result.mounts.some( mount => mount.target === container_targets.claude ) ).toBe( false )
            expect( result.mounts.some( mount => mount.key === `CLAUDE_CODE_OAUTH_TOKEN` ) ).toBe( false )
            expect( result.tmpfiles.claude ).toBeUndefined()
            await result.sync.stop()
            result.sync.cleanup()
        } finally {
            delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        }

    } )

    it( `legacy session records keep syncing their captured Claude /login until the final flush`, async () => {

        // A pre-setup-token launch staged Claude's /login and stored its tmpfile
        const legacy = mkdtempSync( join( tmpdir(), `babysit-creds-legacy-` ) )
        const tmpfile = join( legacy, `claude.json` )
        writeFileSync( tmpfile, readFileSync( host_credential_path( `claude` ), `utf-8` ) )

        const monitor = await setup_credentials( get_agent( `codex` ), {
            existing_tmpfiles: { claude: tmpfile },
            sync_baselines: {},
        } )

        expect( Object.keys( monitor.tmpfiles ) ).toEqual( [ `claude` ] )
        writeFileSync( tmpfile, `{"agent":"claude","refresh_token":"rotated"}` )
        await monitor.sync.stop()

        expect( readFileSync( host_credential_path( `claude` ), `utf-8` ) )
            .toBe( `{"agent":"claude","refresh_token":"rotated"}` )
        rmSync( legacy, { recursive: true, force: true } )

    } )

    it( `monitor handoff reuses every foreground tmpfile without creating new mounts`, async () => {

        const foreground = await setup_credentials( get_agent( `codex` ) )
        await foreground.sync.stop()
        const monitor = await setup_credentials( get_agent( `codex` ), {
            existing_tmpfiles: foreground.tmpfiles,
            sync_baselines: foreground.sync.baselines(),
        } )

        expect( monitor.mounts.find( mount => mount.type === `synced_file` ) ).toBeUndefined()
        expect( monitor.tmpfiles ).toEqual( foreground.tmpfiles )

        writeFileSync( foreground.tmpfiles.opencode, `{"agent":"opencode","refresh_token":"rotated"}` )
        await monitor.sync.stop()
        monitor.sync.cleanup()
        expect( Object.values( foreground.tmpfiles ).every( path => !existsSync( path ) ) ).toBe( true )

        expect( readFileSync( host_credential_path( `opencode` ), `utf-8` ) )
            .toBe( `{"agent":"opencode","refresh_token":"rotated"}` )

    } )

    it( `legacy monitor handoff syncs only the active agent tmpfile`, async () => {

        const foreground = await setup_credentials( get_agent( `codex` ) )
        const legacy_monitor = await setup_credentials( get_agent( `codex` ), {
            existing_tmpfile: foreground.tmpfiles.codex,
            sync_baseline: foreground.sync_baselines.codex,
        } )

        expect( legacy_monitor.mounts.find( mount => mount.type === `synced_file` ) ).toBeUndefined()
        expect( Object.keys( legacy_monitor.tmpfiles ) ).toEqual( [ `codex` ] )

        await foreground.sync.stop()

        writeFileSync( foreground.tmpfiles.codex, `{"agent":"codex","refresh_token":"legacy-rotated"}` )
        await legacy_monitor.sync.stop()
        legacy_monitor.sync.cleanup()
        foreground.sync.cleanup()
        expect( Object.values( foreground.tmpfiles ).every( path => !existsSync( path ) ) ).toBe( true )

        expect( readFileSync( host_credential_path( `codex` ), `utf-8` ) )
            .toBe( `{"agent":"codex","refresh_token":"legacy-rotated"}` )

    } )

} )
