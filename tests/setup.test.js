import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
    build_claude_settings_tmpfile,
    build_claude_json_tmpfile,
    claude_extra_mounts,
    codex_extra_mounts,
    gemini_extra_mounts,
    opencode_extra_mounts,
    get_extra_mounts,
    CODEX_KNOWN_MODELS_FOR_NUX,
    ONBOARDING_VERSION_SENTINEL,
} from '../src/agents/setup.js'

// build_claude_settings_tmpfile and build_claude_json_tmpfile are unit-tested
// here directly because they're the seam the docker run mount actually uses.
// claude_extra_mounts / codex_extra_mounts / gemini_extra_mounts read from
// the host's real ~/.claude / ~/.codex / ~/.gemini, which we can't fake
// without mounting a sandboxed HOME — so those higher-level builders only
// get smoke tests here.

describe( `build_claude_settings_tmpfile`, () => {

    let dir

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-setup-` ) )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `creates a tmpfile with statusLine when host settings.json is missing`, () => {

        const host_path = join( dir, `nonexistent.json` )
        const tmpfile = build_claude_settings_tmpfile( host_path )

        expect( tmpfile ).toBeTruthy()
        expect( existsSync( tmpfile ) ).toBe( true )

        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )
        expect( settings.statusLine ).toEqual( {
            type: `command`,
            command: `bash /usr/local/bin/statusline.sh`,
        } )

        rmSync( tmpfile )

    } )

    it( `merges host settings with statusLine`, () => {

        const host_path = join( dir, `settings.json` )
        writeFileSync( host_path, JSON.stringify( { theme: `dark`, model: `sonnet` } ) )

        const tmpfile = build_claude_settings_tmpfile( host_path )
        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( settings.theme ).toBe( `dark` )
        expect( settings.model ).toBe( `sonnet` )
        expect( settings.statusLine.command ).toBe( `bash /usr/local/bin/statusline.sh` )

        rmSync( tmpfile )

    } )

    it( `does not mutate the host settings file`, () => {

        const host_path = join( dir, `settings.json` )
        const original = { theme: `light`, statusLine: `something else` }
        writeFileSync( host_path, JSON.stringify( original ) )

        build_claude_settings_tmpfile( host_path )

        const after = JSON.parse( readFileSync( host_path, `utf-8` ) )
        expect( after ).toEqual( original )

    } )

    it( `produces a tmpfile with chmod 666`, () => {

        const tmpfile = build_claude_settings_tmpfile( join( dir, `nonexistent.json` ) )
        // 0o777 mask + check the world-readable / world-writable bits.
        // The container's `node` user (uid 1000) is "other" relative to the
        // host's tmpfile owner — without this bit it can't update the file.
        const mode = statSync( tmpfile ).mode & 0o777
        expect( mode ).toBe( 0o666 )

    } )

} )

describe( `build_claude_json_tmpfile`, () => {

    let dir

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-setup-` ) )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `injects /workspace as a trusted project on a fresh file`, () => {

        const tmpfile = build_claude_json_tmpfile( join( dir, `does-not-exist.json` ) )
        const parsed = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( parsed.projects[ `/workspace` ].hasTrustDialogAccepted ).toBe( true )
        expect( parsed.hasCompletedOnboarding ).toBe( true )

    } )

    it( `pins lastOnboardingVersion to a sentinel newer than any real release`, () => {

        // Without this, when the container's claude is newer than the host's
        // recorded onboarding version, claude reruns the version-delta
        // onboarding flow (theme picker etc.) on every fresh container.
        // See GOTCHAS.md #30.
        const host_path = join( dir, `.claude.json` )
        writeFileSync( host_path, JSON.stringify( { lastOnboardingVersion: `2.1.123` } ) )

        const tmpfile = build_claude_json_tmpfile( host_path )
        const parsed = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( parsed.lastOnboardingVersion ).toBe( ONBOARDING_VERSION_SENTINEL )
        expect( parsed.lastOnboardingVersion ).not.toBe( `2.1.123` )

    } )

    it( `preserves host oauthAccount and existing projects entries`, () => {

        const host_path = join( dir, `.claude.json` )
        writeFileSync( host_path, JSON.stringify( {
            oauthAccount: { email: `mentor@palokaj.co` },
            projects: {
                '/some/other/path': { hasTrustDialogAccepted: true, allowedTools: [ `Bash` ] },
            },
        } ) )

        const tmpfile = build_claude_json_tmpfile( host_path )
        const parsed = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( parsed.oauthAccount.email ).toBe( `mentor@palokaj.co` )
        expect( parsed.projects[ `/some/other/path` ].allowedTools ).toEqual( [ `Bash` ] )
        expect( parsed.projects[ `/workspace` ].hasTrustDialogAccepted ).toBe( true )

    } )

    it( `does not mutate the host file`, () => {

        const host_path = join( dir, `.claude.json` )
        const original = { numStartups: 7, hasCompletedOnboarding: false, projects: {} }
        writeFileSync( host_path, JSON.stringify( original ) )

        build_claude_json_tmpfile( host_path )

        const after = JSON.parse( readFileSync( host_path, `utf-8` ) )
        expect( after ).toEqual( original )

    } )

    it( `produces a tmpfile with chmod 666`, () => {

        // Critical for claude rendering — without world-write the container's
        // node user can't update .claude.json mid-init and the TUI hangs
        // before drawing the welcome screen. See .notes/GOTCHAS.md #29-#30.
        const tmpfile = build_claude_json_tmpfile( join( dir, `nope.json` ) )
        const mode = statSync( tmpfile ).mode & 0o777
        expect( mode ).toBe( 0o666 )

    } )

} )

describe( `claude_extra_mounts`, () => {

    it( `includes settings.json and .claude.json mount targets`, () => {

        const mounts = claude_extra_mounts()
        const targets = mounts.map( m => m.container )

        expect( targets ).toContain( `/home/node/.claude/settings.json` )
        expect( targets ).toContain( `/home/node/.claude/.claude.json` )

    } )

} )

describe( `codex_extra_mounts`, () => {

    it( `does NOT mount installation_id (regression: triggers EPERM in container)`, () => {

        // Mounting host installation_id into the container makes codex's
        // session machinery fail with "Failed to create session: Operation
        // not permitted" on /home/node/.codex/sessions. See GOTCHAS.md #33.
        const mounts = codex_extra_mounts()
        const has_installation_id = mounts.some( m => m.container.endsWith( `installation_id` ) )
        expect( has_installation_id ).toBe( false )

    } )

    it( `produces a config.toml mount with /workspace trusted and known model nags suppressed`, () => {

        const mounts = codex_extra_mounts()
        const config_mount = mounts.find( m => m.container === `/home/node/.codex/config.toml` )
        // If the host has no config.toml we'd skip this mount entirely; the
        // test environment has one, so we expect the mount to be present.
        expect( config_mount ).toBeTruthy()

        const content = readFileSync( config_mount.host, `utf-8` )
        expect( content ).toContain( `[projects."/workspace"]` )
        expect( content ).toContain( `trust_level = "trusted"` )
        // Each known model gets pre-marked seen so codex doesn't pop the
        // "Try new model" intro on a fresh container.
        for ( const model of CODEX_KNOWN_MODELS_FOR_NUX ) {
            expect( content ).toContain( `"${ model }" = ` )
        }

    } )

} )

describe( `gemini_extra_mounts`, () => {

    it( `synthesises a trustedFolders.json with /workspace trusted`, () => {

        const mounts = gemini_extra_mounts()
        const trust_mount = mounts.find( m => m.container.endsWith( `trustedFolders.json` ) )
        expect( trust_mount ).toBeTruthy()

        const parsed = JSON.parse( readFileSync( trust_mount.host, `utf-8` ) )
        expect( parsed[ `/workspace` ] ).toBe( `TRUST_FOLDER` )

    } )

} )

describe( `opencode_extra_mounts`, () => {

    it( `returns no extra mounts (auth.json handled by credentials, no other state needed)`, () => {

        expect( opencode_extra_mounts() ).toEqual( [] )

    } )

} )

describe( `get_extra_mounts`, () => {

    it( `dispatches to each agent's builder`, () => {

        // This guards the registry — adding a new agent without wiring its
        // builder here would silently skip its first-run bypasses.
        expect( typeof get_extra_mounts( `claude` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `codex` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `gemini` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `opencode` ) ).toBe( `function` )
        // Unknown agent → no-op builder, never throws.
        expect( get_extra_mounts( `unknown` )() ).toEqual( [] )

    } )

} )
