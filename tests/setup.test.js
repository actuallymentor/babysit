import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse as parse_toml } from 'smol-toml'

import {
    build_claude_settings_tmpfile,
    build_claude_json_tmpfile,
    build_codex_config_tmpdir,
    claude_extra_mounts,
    codex_extra_mounts,
    antigravity_extra_mounts,
    opencode_extra_mounts,
    get_extra_mounts,
    CODEX_KNOWN_MODELS_FOR_NUX,
    ONBOARDING_VERSION_SENTINEL,
} from '../src/agents/setup.js'

// build_claude_settings_tmpfile and build_claude_json_tmpfile are unit-tested
// here directly because they're the seam the docker run mount actually uses.
// claude_extra_mounts / codex_extra_mounts / antigravity_extra_mounts read from
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

    it( `builds a clean settings file when host preferences are isolated`, () => {

        const host_path = join( dir, `settings.json` )
        writeFileSync( host_path, JSON.stringify( {
            model: `opus`,
            hooks: { PreToolUse: [ { command: `host-hook` } ] },
        } ) )

        const tmpfile = build_claude_settings_tmpfile( host_path, {
            include_host_preferences: false,
        } )
        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( settings.model ).toBeUndefined()
        expect( settings.hooks ).toBeUndefined()
        expect( settings.statusLine.command ).toBe( `bash /usr/local/bin/statusline.sh` )

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

    it( `omits skipDangerousModePermissionPrompt when yolo is off`, () => {

        const tmpfile = build_claude_settings_tmpfile( join( dir, `nonexistent.json` ) )
        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )
        expect( settings.skipDangerousModePermissionPrompt ).toBeUndefined()

    } )

    it( `sets skipDangerousModePermissionPrompt at top-level when yolo is on`, () => {

        const tmpfile = build_claude_settings_tmpfile( join( dir, `nonexistent.json` ), { yolo: true } )
        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )
        // Must be top-level (not nested under "permissions") — claude only honours it there.
        expect( settings.skipDangerousModePermissionPrompt ).toBe( true )
        expect( settings.permissions?.skipDangerousModePermissionPrompt ).toBeUndefined()

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

    it( `builds clean onboarding state when host preferences are isolated`, () => {

        const host_path = join( dir, `.claude.json` )
        writeFileSync( host_path, JSON.stringify( {
            oauthAccount: { email: `host@example.com` },
            projects: { '/workspace': { allowedTools: [ `Bash` ] } },
        } ) )

        const tmpfile = build_claude_json_tmpfile( host_path, {
            include_host_preferences: false,
        } )
        const parsed = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( parsed.oauthAccount ).toBeUndefined()
        expect( parsed.projects[ `/workspace` ].allowedTools ).toEqual( [] )
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

    it( `omits instructions and skills from an auth probe`, () => {

        const targets = claude_extra_mounts( { auth_probe: true } )
            .map( mount => mount.container )

        expect( targets ).toEqual( [
            `/home/node/.claude/settings.json`,
            `/home/node/.claude/.claude.json`,
        ] )

    } )

} )

describe( `codex_extra_mounts`, () => {

    it( `copies shared AGENTS.md into the writable CODEX_HOME tmpdir`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-codex-globals-` ) )
        const user_globals_path = join( dir, `AGENTS.md` )
        writeFileSync( user_globals_path, `Use the shared instructions.\n` )

        const { tmpdir: codex_home, provides_user_globals } = build_codex_config_tmpdir( ``, { user_globals_path } )

        expect( provides_user_globals ).toBe( true )
        expect( readFileSync( join( codex_home, `AGENTS.md` ), `utf-8` ) ).toBe( `Use the shared instructions.\n` )
        expect( readFileSync( join( codex_home, `config.toml` ), `utf-8` ) ).toContain( `[projects."/workspace"]` )

        rmSync( dir, { recursive: true, force: true } )
        rmSync( codex_home, { recursive: true, force: true } )

    } )

    it( `does not claim shared globals when AGENTS.md is missing`, () => {

        const missing_path = join( tmpdir(), `babysit-missing-agents-${ Date.now() }.md` )
        const { tmpdir: codex_home, provides_user_globals } = build_codex_config_tmpdir( ``, {
            user_globals_path: missing_path,
        } )

        expect( provides_user_globals ).toBe( false )
        expect( existsSync( join( codex_home, `AGENTS.md` ) ) ).toBe( false )

        rmSync( codex_home, { recursive: true, force: true } )

    } )

    it( `keeps config but omits global instructions for an auth probe`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-codex-auth-profile-` ) )
        const user_globals_path = join( dir, `AGENTS.md` )
        writeFileSync( user_globals_path, `Do unrelated startup work.\n` )

        const { tmpdir: codex_home, provides_user_globals } = build_codex_config_tmpdir(
            `model_provider = "custom"\n`,
            { user_globals_path, include_user_globals: false }
        )

        expect( provides_user_globals ).toBe( false )
        expect( existsSync( join( codex_home, `AGENTS.md` ) ) ).toBe( false )
        expect( readFileSync( join( codex_home, `config.toml` ), `utf-8` ) )
            .toContain( `model_provider = "custom"` )

        rmSync( dir, { recursive: true, force: true } )
        rmSync( codex_home, { recursive: true, force: true } )

    } )

    it( `omits host config and AGENTS.md when preferences are isolated`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-codex-isolated-` ) )
        const user_globals_path = join( dir, `AGENTS.md` )
        writeFileSync( user_globals_path, `Use host instructions.\n` )

        const { tmpdir: codex_home, provides_user_globals } = build_codex_config_tmpdir(
            `[mcp_servers.host]\ncommand = "host-tool"\n`,
            { user_globals_path, include_host_preferences: false }
        )

        const config = readFileSync( join( codex_home, `config.toml` ), `utf-8` )
        expect( provides_user_globals ).toBe( false )
        expect( existsSync( join( codex_home, `AGENTS.md` ) ) ).toBe( false )
        expect( config ).not.toContain( `mcp_servers.host` )
        expect( config ).toContain( `[projects."/workspace"]` )

        rmSync( dir, { recursive: true, force: true } )
        rmSync( codex_home, { recursive: true, force: true } )

    } )

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
        const config_mount = mounts.find( m => m.container === `/home/node/.codex` )
        expect( config_mount ).toBeTruthy()

        const content = readFileSync( join( config_mount.host, `config.toml` ), `utf-8` )
        expect( content ).toContain( `[projects."/workspace"]` )
        expect( content ).toContain( `trust_level = "trusted"` )
        expect( content ).toContain( `check_for_update_on_startup = false` )
        // Each known model gets pre-marked seen so codex doesn't pop the
        // "Try new model" intro on a fresh container.
        for( const model of CODEX_KNOWN_MODELS_FOR_NUX ) {
            expect( parse_toml( content ).tui.model_availability_nux[model] ).toBeGreaterThanOrEqual( 1 )
        }

    } )

    it( `preserves equivalent TOML key forms and remains valid on repeated staging`, () => {

        const fixtures = [
            `[tui.model_availability_nux]\ngpt-6-astra = 4\n'gpt-5.6-sol' = 3\n"gpt-5.5" = 1\n`,
            `[ 'tui' . "model_availability_nux" ] # native formatting\r\ngpt-6-astra = 4\r\n`,
            `tui.model_availability_nux.gpt-6-astra = 4\n`,
            `tui = { model_availability_nux = { gpt-6-astra = 4 } }\n`,
        ]
        for( const raw of fixtures ) {
            const first = build_codex_config_tmpdir( raw, { include_user_globals: false } )
            let second
            try {
                const content = readFileSync( join( first.tmpdir, `config.toml` ), `utf-8` )
                const parsed = parse_toml( content )
                expect( parsed.tui.model_availability_nux ).toMatchObject( parse_toml( raw ).tui.model_availability_nux )
                for( const model of CODEX_KNOWN_MODELS_FOR_NUX ) {
                    expect( parsed.tui.model_availability_nux[model] ).toBeGreaterThanOrEqual( 1 )
                }
                second = build_codex_config_tmpdir( content, { include_user_globals: false } )
                expect( readFileSync( join( second.tmpdir, `config.toml` ), `utf-8` ) ).toBe( content )
            } finally {
                rmSync( first.tmpdir, { recursive: true, force: true } )
                if( second ) rmSync( second.tmpdir, { recursive: true, force: true } )
            }
        }

    } )

    it( `preserves unrelated config values and scopes injected keys to their tables`, () => {

        const raw = `model = "custom-model"
notify = ["custom-notify", "--flag"]
[profiles.custom]
gpt-6-astra = 9
apps = true
check_for_update_on_startup = true
limit = 9223372036854775807
ratio = 1.0
[projects.'/workspace']
trust_level = "trusted"
custom = "retained"
`
        const { tmpdir: codex_home } = build_codex_config_tmpdir( raw, { include_user_globals: false } )
        try {
            const content = readFileSync( join( codex_home, `config.toml` ), `utf-8` )
            const parsed = parse_toml( content, { integersAsBigInt: true } )
            const original = parse_toml( raw, { integersAsBigInt: true } )
            expect( parsed.profiles ).toEqual( original.profiles )
            expect( parsed.projects ).toEqual( original.projects )
            expect( parsed.model ).toBe( original.model )
            expect( parsed.notify ).toEqual( original.notify )
            expect( parsed.features.apps ).toBe( false )
            expect( parsed.check_for_update_on_startup ).toBe( false )
            expect( parsed.tui.model_availability_nux[`gpt-6-astra`] ).toBe( 2n )
        } finally {
            rmSync( codex_home, { recursive: true, force: true } )
        }

    } )

    it( `rejects malformed config without exposing its source contents`, () => {

        const raw = `secret = "do-not-print-this"\nsecret = "also-private"\n`
        expect( () => build_codex_config_tmpdir( raw ) ).toThrow( /Invalid Codex config.toml at line 2, column/ )
        try {
            build_codex_config_tmpdir( raw )
        } catch ( error ) {
            expect( error.message ).not.toContain( `do-not-print-this` )
            expect( error.message ).not.toContain( `also-private` )
        }
        expect( () => build_codex_config_tmpdir( `tui = false` ) ).toThrow( /'tui' must be a table/ )

    } )

    it( `overrides Codex's host update check in the container snapshot`, () => {

        const { tmpdir: codex_home } = build_codex_config_tmpdir(
            `check_for_update_on_startup = true\n[features]\napps = true\n`
        )
        const content = readFileSync( join( codex_home, `config.toml` ), `utf-8` )

        expect( content.match( /^check_for_update_on_startup\s*=.*$/gm ) ).toEqual( [
            `check_for_update_on_startup = false`,
        ] )

        rmSync( codex_home, { recursive: true, force: true } )

    } )

    it( `mounts a writable config dir so Codex can atomically persist config.toml`, () => {

        const mounts = codex_extra_mounts()
        const config_mount = mounts.find( m => m.container === `/home/node/.codex` )
        expect( config_mount ).toBeTruthy()

        // Codex persists config changes by writing a temp file and renaming it
        // over config.toml. A single-file bind mount accepts in-place writes
        // but rejects that atomic replace path, causing "failed to persist
        // config.toml" when changing the default model in the TUI.
        expect( statSync( config_mount.host ).isDirectory() ).toBe( true )
        expect( statSync( config_mount.host ).mode & 0o777 ).toBe( 0o777 )
        expect( statSync( join( config_mount.host, `config.toml` ) ).mode & 0o777 ).toBe( 0o666 )

    } )

    it( `disables the codex_apps MCP via [features] apps = false`, () => {

        // The codex_apps MCP demands a fresh OAuth access token at startup
        // and emits a noisy "token_expired" warning on every fresh container
        // (codex exposes no CLI command to force a token refresh, so the
        // pre-flight cannot guarantee the host token is current). The
        // connectors are also useless inside a sandboxed coding-agent
        // container. Disabled here via the documented features flag.
        const mounts = codex_extra_mounts()
        const config_mount = mounts.find( m => m.container === `/home/node/.codex` )
        expect( config_mount ).toBeTruthy()

        const content = readFileSync( join( config_mount.host, `config.toml` ), `utf-8` )
        expect( content ).toMatch( /\[features\][\s\S]*apps\s*=\s*false/ )

    } )

    it( `reads host config.toml from CODEX_HOME when set`, () => {

        const original_codex_home = process.env.CODEX_HOME
        const dir = mkdtempSync( join( tmpdir(), `babysit-codex-home-` ) )

        try {

            process.env.CODEX_HOME = dir
            writeFileSync( join( dir, `config.toml` ), `[projects."/custom-host"]\ntrust_level = "trusted"\n` )

            const mounts = codex_extra_mounts()
            const config_mount = mounts.find( m => m.container === `/home/node/.codex` )
            expect( config_mount ).toBeTruthy()

            const content = readFileSync( join( config_mount.host, `config.toml` ), `utf-8` )
            expect( content ).toContain( `[projects."/custom-host"]` )
            expect( content ).toContain( `[projects."/workspace"]` )

        } finally {
            if( original_codex_home === undefined ) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = original_codex_home
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

} )

describe( `antigravity_extra_mounts`, () => {

    let dir
    let original_api_key
    let generated_mounts

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-antigravity-profile-` ) )
        original_api_key = process.env.GEMINI_API_KEY
        delete process.env.GEMINI_API_KEY
        generated_mounts = []
    } )

    afterEach( () => {
        if( original_api_key === undefined ) delete process.env.GEMINI_API_KEY
        else process.env.GEMINI_API_KEY = original_api_key
        generated_mounts.forEach( mount => rmSync( mount.host, { force: true } ) )
        rmSync( dir, { recursive: true, force: true } )
    } )

    const stage = options => {
        const mounts = antigravity_extra_mounts( { antigravity_dir: dir, config_dir: dir, ...options } )
        generated_mounts.push( ...mounts )
        return mounts
    }
    const read_mount = ( mounts, suffix ) => JSON.parse( readFileSync( mounts.find( mount => mount.container.endsWith( suffix ) ).host, `utf8` ) )

    it( `isolates native provider selection from host preferences`, () => {
        writeFileSync( join( dir, `settings.json` ), JSON.stringify( {
            modelProvider: `gemini`, theme: `dark`, model: `host-model`,
            security: { auth: { selectedType: `legacy-gemini-oauth` } },
        } ) )
        const mounts = stage( { include_host_preferences: false } )
        expect( read_mount( mounts, `/settings.json` ) ).toEqual( { modelProvider: `gemini` } )
    } )

    it( `selects the native Gemini API provider when an API key is supplied`, () => {
        process.env.GEMINI_API_KEY = `test-key`
        const mounts = stage()
        expect( read_mount( mounts, `/settings.json` ) ).toEqual( { modelProvider: `gemini` } )
    } )

    it( `does not carry legacy Gemini authentication selection into an isolated profile`, () => {
        writeFileSync( join( dir, `settings.json` ), JSON.stringify( { security: { auth: { selectedType: `oauth-personal` } } } ) )
        const mounts = stage( { include_host_preferences: false } )
        expect( read_mount( mounts, `/settings.json` ) ).toEqual( {} )
    } )

    it( `carries completed native onboarding without inventing consent`, () => {
        const empty = stage( { include_host_preferences: false } )
        expect( empty.some( mount => mount.container.endsWith( `/onboarding.json` ) ) ).toBe( false )
        mkdirSync( join( dir, `cache` ) )
        const onboarding = { consumerOnboardingComplete: true, enterpriseOnboardingComplete: false, onboardingComplete: true }
        writeFileSync( join( dir, `cache`, `onboarding.json` ), JSON.stringify( onboarding ) )
        const mounts = stage( { include_host_preferences: false } )
        expect( read_mount( mounts, `/cache/onboarding.json` ) ).toEqual( onboarding )
    } )

    it( `never seeds unfinished or invalid host onboarding over completed container state`, () => {
        mkdirSync( join( dir, `cache` ) )
        for( const state of [ { onboardingComplete: false }, {}, null, [], `invalid` ] ) {
            writeFileSync( join( dir, `cache`, `onboarding.json` ), JSON.stringify( state ) )
            const mounts = stage()
            expect( mounts.some( mount => mount.container.endsWith( `/onboarding.json` ) ) ).toBe( false )
        }
    } )

    it( `retains host customizations and adds native hooks outside isolation`, () => {
        for( const file of [ `config.json`, `mcp_config.json` ] ) writeFileSync( join( dir, file ), `{}` )
        const existing = { user: { Stop: [ { type: `command`, command: `user-command` } ] } }
        writeFileSync( join( dir, `hooks.json` ), JSON.stringify( existing ) )
        const mounts = stage( { completion_capture: {} } )
        expect( mounts.map( mount => mount.container ) ).toEqual( expect.arrayContaining( [
            `/home/node/.gemini/config/config.json`, `/home/node/.gemini/config/mcp_config.json`,
        ] ) )
        const hooks = read_mount( mounts, `/hooks.json` )
        expect( hooks.user ).toEqual( existing.user )
        expect( Object.keys( hooks[ `babysit-completion` ] ) ).toEqual( [ `PreInvocation`, `Stop` ] )
        expect( hooks[ `babysit-completion` ].Stop[0].command ).toContain( `antigravity Stop` )
        expect( JSON.parse( readFileSync( join( dir, `hooks.json` ), `utf8` ) ) ).toEqual( existing )
    } )

    it( `omits host customizations in isolation but keeps completion hooks`, () => {
        for( const file of [ `config.json`, `mcp_config.json`, `hooks.json` ] ) writeFileSync( join( dir, file ), `{"host":{}}` )
        const mounts = stage( { include_host_preferences: false, completion_capture: {} } )
        expect( mounts.map( mount => mount.container ) ).toEqual( [
            `/home/node/.gemini/antigravity-cli/settings.json`, `/home/node/.gemini/config/hooks.json`,
        ] )
        expect( Object.keys( read_mount( mounts, `/hooks.json` ) ) ).toEqual( [ `babysit-completion` ] )
    } )

    it( `auth probes omit user hooks, completion hooks, customizations, and onboarding`, () => {
        mkdirSync( join( dir, `cache` ) )
        for( const file of [ `config.json`, `mcp_config.json`, `hooks.json`, `cache/onboarding.json` ] ) writeFileSync( join( dir, file ), `{"host":{}}` )
        const mounts = stage( { auth_probe: true, completion_capture: {} } )
        expect( mounts.map( mount => mount.container ) ).toEqual( [
            `/home/node/.gemini/antigravity-cli/settings.json`, `/home/node/.gemini/config/hooks.json`,
        ] )
        expect( read_mount( mounts, `/hooks.json` ) ).toEqual( {} )
    } )

    it( `normalizes non-object native hooks before installing capture hooks`, () => {
        for( const value of [ null, [], `invalid` ] ) {
            writeFileSync( join( dir, `hooks.json` ), JSON.stringify( value ) )
            const mounts = stage( { completion_capture: {} } )
            expect( Object.keys( read_mount( mounts, `/hooks.json` ) ) ).toEqual( [ `babysit-completion` ] )
        }
    } )

} )

describe( `opencode_extra_mounts`, () => {

    it( `returns no extra mounts for normal sessions`, () => {

        expect( opencode_extra_mounts() ).toEqual( [] )

    } )

    it( `stages a tool-free primary agent for auth probes`, () => {

        const [ mount ] = opencode_extra_mounts( { auth_probe: true } )

        try {
            expect( mount.type ).toBe( `seed_file` )
            expect( mount.target ).toBe( `/home/node/.config/opencode/opencode.json` )
            expect( JSON.parse( readFileSync( mount.source, `utf8` ) ) ).toEqual( {
                agent: {
                    'babysit-auth': {
                        mode: `primary`,
                        permission: `deny`,
                        tools: { '*': false },
                    },
                },
            } )
        } finally {
            rmSync( mount.cleanup, { recursive: true, force: true } )
        }

    } )

    it( `stages the same sanitized project route for sessions and probes`, () => {

        const workspace = mkdtempSync( join( tmpdir(), `babysit-opencode-setup-route-` ) )
        writeFileSync( join( workspace, `opencode.json` ), JSON.stringify( {
            provider: {
                custom: {
                    options: { baseURL: `https://example.test/v1` },
                },
            },
            model: `custom/model`,
            plugin: [ `unsafe-plugin` ],
        } ) )
        const [ session_mount ] = opencode_extra_mounts( {
            workspace,
            include_host_preferences: false,
        } )
        const [ probe_mount ] = opencode_extra_mounts( {
            workspace,
            include_host_preferences: false,
            auth_probe: true,
        } )

        try {
            const session_config = JSON.parse( readFileSync( session_mount.source, `utf8` ) )
            const probe_config = JSON.parse( readFileSync( probe_mount.source, `utf8` ) )

            expect( session_config.provider ).toEqual( probe_config.provider )
            expect( session_config.model ).toBe( `custom/model` )
            expect( session_config ).not.toHaveProperty( `plugin` )
            expect( session_config ).not.toHaveProperty( `agent` )
            expect( probe_config.agent[ `babysit-auth` ].tools ).toEqual( { '*': false } )
        } finally {
            rmSync( session_mount.cleanup, { recursive: true, force: true } )
            rmSync( probe_mount.cleanup, { recursive: true, force: true } )
            rmSync( workspace, { recursive: true, force: true } )
        }

    } )

} )

describe( `get_extra_mounts`, () => {

    it( `dispatches to each agent's builder`, () => {

        // This guards the registry — adding a new agent without wiring its
        // builder here would silently skip its first-run bypasses.
        expect( typeof get_extra_mounts( `claude` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `codex` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `antigravity` ) ).toBe( `function` )
        expect( typeof get_extra_mounts( `opencode` ) ).toBe( `function` )
        // Unknown agent → no-op builder, never throws.
        expect( get_extra_mounts( `unknown` )() ).toEqual( [] )

    } )

} )
