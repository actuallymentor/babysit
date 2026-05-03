import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
