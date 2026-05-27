import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { get_agent } from '../src/agents/index.js'
import { setup_credentials } from '../src/credentials/index.js'
import { setup_linux_credentials } from '../src/credentials/linux.js'

// Regression suite for the monitor-tmpfile fix.
//
// The bug: cmd_monitor was calling `setup_credentials(agent)` with no options,
// which made `copy_host_file_to_tmpfile` mint a brand-new tmpfile (the path
// includes Date.now()). The container had been started by the foreground with
// the foreground's tmpfile bind-mounted, so the monitor's sync watched the
// wrong file. Container-side OAuth refreshes never made it back to the host
// auth.json, and the next babysit session failed with "refresh token already
// used" the moment the agent started.
//
// Fix: setup_credentials now accepts `{ existing_tmpfile }`, and cmd_monitor
// passes session.creds_tmpfile so its sync watches the SAME tmpfile the
// container is mounting.

describe( `setup_linux_credentials existing_tmpfile`, () => {

    let dir
    let original_home
    const fake_agent = {
        name: `codex-test`,
        bin: `true`, // pre-flight runs `${bin} --version`; `true` is a safe no-op
        credentials: {
            linux: { file: `~/.codex/auth.json` },
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

        const { mounts, sync } = await setup_linux_credentials( fake_agent )

        const volume = mounts.find( m => m.type === `volume` )

        expect( volume ).toBeDefined()
        expect( volume.target ).toBe( `/home/node/.codex/auth.json` )
        expect( existsSync( volume.source ) ).toBe( true )
        expect( readFileSync( volume.source, `utf-8` ) ).toBe( `{"refresh_token":"original"}` )

        await sync.stop()

    } )

    it( `re-uses the existing tmpfile when passed — no new file, no new mount`, async () => {

        // Foreground path
        const fg = await setup_linux_credentials( fake_agent )
        const fg_tmpfile = fg.mounts.find( m => m.type === `volume` ).source

        // Monitor path: same agent, but pass the foreground's tmpfile
        const mon = await setup_linux_credentials( fake_agent, { existing_tmpfile: fg_tmpfile } )

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

    } )

    it( `preserves a tmpfile rotation that happened before the monitor starts`, async () => {

        const fg = await setup_linux_credentials( fake_agent )
        const fg_tmpfile = fg.mounts.find( m => m.type === `volume` ).source

        // Simulate codex refreshing during startup before the detached monitor
        // has established its credential sync. The monitor receives the
        // foreground capture baseline through session metadata, so it knows
        // the host file is stale and the tmpfile is fresh.
        writeFileSync( fg_tmpfile, `{"refresh_token":"startup-rotated"}` )

        const mon = await setup_linux_credentials( fake_agent, {
            existing_tmpfile: fg_tmpfile,
            sync_baseline: fg.sync_baseline,
        } )

        await mon.sync.stop()

        expect( readFileSync( join( dir, `.codex/auth.json` ), `utf-8` ) )
            .toBe( `{"refresh_token":"startup-rotated"}` )
        expect( readFileSync( fg_tmpfile, `utf-8` ) )
            .toBe( `{"refresh_token":"startup-rotated"}` )

        await fg.sync.stop()

    } )

    it( `with existing_tmpfile, host-file changes still flow to the tmpfile (direction 1)`, async () => {

        const fg = await setup_linux_credentials( fake_agent )
        const fg_tmpfile = fg.mounts.find( m => m.type === `volume` ).source

        const mon = await setup_linux_credentials( fake_agent, { existing_tmpfile: fg_tmpfile } )

        // Stop the foreground's sync so only the monitor's sync is watching —
        // otherwise both syncs race on the same tmpfile and the test gets noisy.
        await fg.sync.stop()

        // User re-auths on the host (rare). Direction 1 of the sync should push
        // the new content into the tmpfile so the container picks it up.
        writeFileSync( join( dir, `.codex/auth.json` ), `{"refresh_token":"reauthed"}` )

        await mon.sync.stop()

        expect( readFileSync( fg_tmpfile, `utf-8` ) ).toBe( `{"refresh_token":"reauthed"}` )

    } )

} )

describe( `setup_credentials multi-agent capture`, () => {

    let dir
    let original_home
    let original_codex_home
    let original_codex_api_key
    let original_openai_api_key
    let original_gemini_api_key

    const credential_paths = {
        claude: `.claude/.credentials.json`,
        codex: `.codex/auth.json`,
        gemini: `.gemini/oauth_creds.json`,
        opencode: `.local/share/opencode/auth.json`,
    }

    const container_targets = {
        claude: `/home/node/.claude/.credentials.json`,
        codex: `/home/node/.codex/auth.json`,
        gemini: `/home/node/.gemini/oauth_creds.json`,
        opencode: `/home/node/.local/share/opencode/auth.json`,
    }

    const host_credential_path = ( agent_name ) => join( dir, credential_paths[ agent_name ] )

    const seed_host_credentials = () => {

        mkdirSync( join( dir, `.claude` ), { recursive: true } )
        mkdirSync( join( dir, `.codex` ), { recursive: true } )
        mkdirSync( join( dir, `.gemini` ), { recursive: true } )
        mkdirSync( join( dir, `.local/share/opencode` ), { recursive: true } )

        for ( const [ agent_name, relative_path ] of Object.entries( credential_paths ) ) {
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
        original_gemini_api_key = process.env.GEMINI_API_KEY

        process.env.HOME = dir
        delete process.env.CODEX_HOME
        delete process.env.CODEX_API_KEY
        delete process.env.OPENAI_API_KEY
        delete process.env.GEMINI_API_KEY

    } )

    afterEach( () => {

        process.env.HOME = original_home

        if( original_codex_home === undefined ) delete process.env.CODEX_HOME
        else process.env.CODEX_HOME = original_codex_home

        if( original_codex_api_key === undefined ) delete process.env.CODEX_API_KEY
        else process.env.CODEX_API_KEY = original_codex_api_key

        if( original_openai_api_key === undefined ) delete process.env.OPENAI_API_KEY
        else process.env.OPENAI_API_KEY = original_openai_api_key

        if( original_gemini_api_key === undefined ) delete process.env.GEMINI_API_KEY
        else process.env.GEMINI_API_KEY = original_gemini_api_key

        rmSync( dir, { recursive: true, force: true } )

    } )

    it( `captures credential mounts for every supported agent on a codex launch`, async () => {

        const result = await setup_credentials( get_agent( `codex` ) )
        const volume_targets = result.mounts
            .filter( mount => mount.type === `volume` )
            .map( mount => mount.target )

        expect( volume_targets ).toEqual( expect.arrayContaining( Object.values( container_targets ) ) )
        expect( Object.keys( result.tmpfiles ).sort() ).toEqual( [ `claude`, `codex`, `gemini`, `opencode` ] )
        expect( Object.keys( result.sync_baselines ).sort() ).toEqual( [ `claude`, `codex`, `gemini`, `opencode` ] )
        expect( result.creds_tmpfile ).toBeUndefined()

        await result.sync.stop()

    } )

    it( `monitor handoff reuses every foreground tmpfile without creating new mounts`, async () => {

        const foreground = await setup_credentials( get_agent( `codex` ) )
        const monitor = await setup_credentials( get_agent( `codex` ), {
            existing_tmpfiles: foreground.tmpfiles,
            sync_baselines: foreground.sync_baselines,
        } )

        expect( monitor.mounts.find( mount => mount.type === `volume` ) ).toBeUndefined()
        expect( monitor.tmpfiles ).toEqual( foreground.tmpfiles )

        await foreground.sync.stop()

        writeFileSync( foreground.tmpfiles.claude, `{"agent":"claude","refresh_token":"rotated"}` )
        await monitor.sync.stop()

        expect( readFileSync( host_credential_path( `claude` ), `utf-8` ) )
            .toBe( `{"agent":"claude","refresh_token":"rotated"}` )

    } )

    it( `legacy monitor handoff syncs only the active agent tmpfile`, async () => {

        const foreground = await setup_credentials( get_agent( `codex` ) )
        const legacy_monitor = await setup_credentials( get_agent( `codex` ), {
            existing_tmpfile: foreground.tmpfiles.codex,
            sync_baseline: foreground.sync_baselines.codex,
        } )

        expect( legacy_monitor.mounts.find( mount => mount.type === `volume` ) ).toBeUndefined()
        expect( Object.keys( legacy_monitor.tmpfiles ) ).toEqual( [ `codex` ] )

        await foreground.sync.stop()

        writeFileSync( foreground.tmpfiles.codex, `{"agent":"codex","refresh_token":"legacy-rotated"}` )
        await legacy_monitor.sync.stop()

        expect( readFileSync( host_credential_path( `codex` ), `utf-8` ) )
            .toBe( `{"agent":"codex","refresh_token":"legacy-rotated"}` )

    } )

} )
