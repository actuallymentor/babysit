import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PassThrough } from 'stream'
import { build_system_prompt } from '../src/modes/prompt.js'
import { load_monitor_config } from '../src/cli/monitor.js'
import {
    check_startup_agent_authentication,
    is_initial_prompt_ready,
    read_startup_log_tail,
    resolve_initial_prompt,
    startup_diagnostic_log_path,
    wait_for_initial_prompt_ready,
} from '../src/cli/start.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { opencode } from '../src/agents/opencode.js'
import {
    fingerprint_agent_credentials,
    read_host_auth_cache,
    record_host_auth_success,
} from '../src/agents/auth_cache.js'

const read_opencode_fixture = name => readFileSync(
    new URL( `./fixtures/opencode/${ name }.txt`, import.meta.url ),
    `utf8`
).replaceAll( `[ESC]`, `\x1b` )

const startup_auth_fixture = () => {

    const directory = mkdtempSync( join( tmpdir(), `babysit-startup-auth-` ) )
    const credential_path = join( directory, `credential.json` )
    const cache_path = join( directory, `cache.json` )
    const creds_mounts = [ {
        type: `synced_file`,
        source: credential_path,
        target: codex.container_paths.creds,
    } ]
    const input = new PassThrough()
    const output = new PassThrough()
    const raw_modes = []

    writeFileSync( credential_path, `{"refresh_token":"startup-test"}` )
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = raw => {
        raw_modes.push( raw )
        input.isRaw = raw
    }
    output.isTTY = false
    output.resume()

    return {
        cache_path,
        cleanup: () => rmSync( directory, { recursive: true, force: true } ),
        credential_path,
        creds_mounts,
        input,
        output,
        raw_modes,
    }

}

describe( `build_system_prompt`, () => {

    it( `returns the spec base prompt when no mode flags are set`, () => {
        const prompt = build_system_prompt( {} )
        expect( prompt ).toContain( `running inside a Docker container` )
        expect( prompt ).toContain( `Do NOT add Co-Authored-By lines` )
    } )

    it( `appends YOLO fragment when mode.yolo is set`, () => {
        const prompt = build_system_prompt( { yolo: true } )
        expect( prompt ).toContain( `AGENT_AUTONOMY_MODE=yolo` )
        expect( prompt ).toContain( `maximum autonomy` )
    } )

    it( `appends SANDBOX fragment when mode.sandbox is set`, () => {
        const prompt = build_system_prompt( { sandbox: true } )
        expect( prompt ).toContain( `AGENT_AUTONOMY_MODE=sandbox` )
        expect( prompt ).toContain( `/workspace directory is empty` )
    } )

    it( `appends MUDBOX fragment when mode.mudbox is set`, () => {
        const prompt = build_system_prompt( { mudbox: true } )
        expect( prompt ).toContain( `AGENT_AUTONOMY_MODE=mudbox` )
        expect( prompt ).toContain( `READ-ONLY` )
    } )

    it( `combines yolo and mudbox fragments`, () => {
        const prompt = build_system_prompt( { yolo: true, mudbox: true } )
        expect( prompt ).toContain( `READ-ONLY` )
        expect( prompt ).toContain( `maximum autonomy` )
    } )

    it( `appends Docker socket guidance when mode.docker is set`, () => {
        const prompt = build_system_prompt( { docker: true } )
        expect( prompt ).toContain( `Docker-outside-of-Docker is enabled` )
        expect( prompt ).toContain( `BABYSIT_HOST_WORKSPACE` )
    } )

    it( `describes host-profile isolation when requested`, () => {
        const prompt = build_system_prompt( { ignore_host_agents_md: true } )
        expect( prompt ).toContain( `Host-global coding-agent instructions` )
        expect( prompt ).toContain( `host credentials are still available` )
    } )

    it( `does not embed sandbox text when sandbox is false`, () => {
        const prompt = build_system_prompt( { yolo: true } )
        expect( prompt ).not.toContain( `AGENT_AUTONOMY_MODE=sandbox` )
    } )

} )

describe( `load_monitor_config`, () => {

    it( `uses the original mode-aware prompt for legacy configs`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-monitor-config-` ) )

        try {
            writeFileSync( join( dir, `babysit.yaml` ), `
config:
    idle_timeout_s: 60
babysit:
    - on: idle
      do: "keep going"
` )

            const { config } = load_monitor_config( {
                pwd: dir,
                modifiers: [ `yolo`, `docker`, `loop`, `ignore-host-agents-md` ],
            } )

            expect( config.initial_prompt ).toContain( `AGENT_AUTONOMY_MODE=yolo` )
            expect( config.initial_prompt ).toContain( `Docker-outside-of-Docker is enabled` )
            expect( config.initial_prompt ).toContain( `Host-global coding-agent instructions` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

} )

describe( `resolve_initial_prompt`, () => {

    it( `does nothing when config.initial_prompt is null`, () => {
        const prompt = resolve_initial_prompt( { initial_prompt: null } )
        expect( prompt ).toBe( `` )
    } )

    it( `uses config.initial_prompt when provided`, () => {
        const prompt = resolve_initial_prompt( { initial_prompt: `custom launch brief` } )
        expect( prompt ).toBe( `custom launch brief` )
    } )

    it( `allows an empty config.initial_prompt to disable startup typing`, () => {
        const prompt = resolve_initial_prompt( { initial_prompt: `` } )
        expect( prompt ).toBe( `` )
    } )

} )

describe( `initial prompt readiness`, () => {

    it( `treats agents without a readiness pattern as ready`, () => {
        expect( is_initial_prompt_ready( {}, `` ) ).toBe( true )
    } )

    it( `recognises Codex's first TUI screen`, () => {
        const output = `
>_ OpenAI Codex (v0.128.0)
`
        expect( is_initial_prompt_ready( codex, output ) ).toBe( true )
    } )

    it( `recognises Claude's first TUI screen`, () => {
        const output = `
Claude Code v2.1.128
Welcome back Mentor!
`
        expect( is_initial_prompt_ready( claude, output ) ).toBe( true )
    } )

    it( `does not require Claude's banner to use three-part semver`, () => {
        expect( is_initial_prompt_ready( claude, `Claude Code v3` ) ).toBe( true )
    } )

    it( `does not treat early Claude pane echo as ready`, () => {
        const output = `
You are running inside a Docker container.

Do NOT add Co-Authored-By lines to git commit messages.
`
        expect( is_initial_prompt_ready( claude, output ) ).toBe( false )
    } )

    it( `does not treat OpenCode's blank loading pane as ready`, () => {
        const output = read_opencode_fixture( `loading` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( false )
    } )

    it( `recognises OpenCode's real composer screen`, () => {
        const output = read_opencode_fixture( `ready` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( true )
    } )

    it( `recognises OpenCode's ANSI-decorated composer screen`, () => {
        const output = read_opencode_fixture( `ready-ansi` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( true )
    } )

    it( `rejects OpenCode's model error even when the composer remains visible`, () => {
        const output = read_opencode_fixture( `model-error` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( false )
    } )

    it( `rejects OpenCode's auth modal even when the composer remains visible`, () => {
        const output = read_opencode_fixture( `auth-method` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( false )
    } )

    it( `rejects OpenCode's provider picker while it covers the composer`, () => {
        const output = read_opencode_fixture( `provider-picker` )

        expect( is_initial_prompt_ready( opencode, output ) ).toBe( false )
    } )

    it( `checks OpenCode readiness deterministically`, () => {
        const output = read_opencode_fixture( `ready` )
        const results = Array.from( { length: 5 }, () => is_initial_prompt_ready( opencode, output ) )

        expect( results ).toEqual( [ true, true, true, true, true ] )
    } )

    it( `waits until the readiness pattern appears`, async () => {

        const seen = []
        const captures = [ `starting`, `still starting`, `OpenAI Codex` ]

        const ready = await wait_for_initial_prompt_ready( `session`, codex, {
            capture: async ( session_name ) => {
                seen.push( session_name )
                return captures.shift()
            },
            wait_fn: async () => null,
            timeout_ms: 750,
            interval_ms: 250,
        } )

        expect( ready ).toBe( true )
        expect( seen.length ).toBe( 3 )

    } )

    it( `returns false when the ready screen never appears`, async () => {

        const ready = await wait_for_initial_prompt_ready( `session`, codex, {
            capture: async () => `loading`,
            wait_fn: async () => null,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( false )

    } )

    it( `times out while OpenCode stays on a non-ready screen`, async () => {

        const captures = [
            read_opencode_fixture( `loading` ),
            read_opencode_fixture( `model-error` ),
        ]
        const ready = await wait_for_initial_prompt_ready( `session`, opencode, {
            capture: async () => captures.shift() || read_opencode_fixture( `model-error` ),
            wait_fn: async () => null,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( false )

    } )

} )

describe( `startup diagnostics`, () => {

    it( `creates diagnostic paths under Babysit's launch log directory`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-startup-path-` ) )

        try {
            const path = startup_diagnostic_log_path( `babysit_/tmp/project_codex_123`, { babysit_dir: dir } )

            expect( path.startsWith( join( dir, `launch-logs` ) ) ).toBe( true )
            expect( path.endsWith( `.log` ) ).toBe( true )
            expect( path ).not.toContain( `/tmp/project` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `returns a stripped tail from startup output`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-startup-tail-` ) )
        const path = join( dir, `startup.log` )

        try {
            writeFileSync( path, `one\n\x1b[31mtwo\x1b[0m\nthree\n` )

            expect( read_startup_log_tail( path, { max_lines: 2 } ) ).toBe( `two\nthree` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `returns an empty string when no startup log exists`, () => {

        expect( read_startup_log_tail( `/tmp/not-a-real-babysit-startup.log` ) ).toBe( `` )

    } )

} )

describe( `startup authentication policy`, () => {

    it( `checks only the active agent and caches a successful TTY probe`, async () => {

        const fixture = startup_auth_fixture()
        const checked_agents = []

        try {
            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: { yolo: true },
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                run_auth_check: async ( agent, options ) => {
                    checked_agents.push( agent.name )
                    expect( options.signal ).toBeInstanceOf( AbortSignal )
                    return {
                        name: agent.name,
                        status: `authenticated`,
                        authenticated: true,
                    }
                },
            } )

            expect( checked_agents ).toEqual( [ `codex` ] )
            expect( result.results[0].status ).toBe( `authenticated` )
            expect( result.cache_context.image_identity ).toBe( `sha256:test-image` )
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents.codex )
                .toBeDefined()
            expect( fixture.raw_modes ).toEqual( [ true, false ] )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `uses a warm cache before applying the non-TTY skip policy`, async () => {

        const fixture = startup_auth_fixture()
        fixture.input.isTTY = false

        try {
            const credential_identity = fingerprint_agent_credentials( codex, fixture.creds_mounts )
            record_host_auth_success( `codex`, {
                credential_fingerprint: credential_identity.fingerprint,
                image_identity: `sha256:test-image`,
            }, { cache_path: fixture.cache_path } )

            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: {},
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                run_auth_check: async () => {
                    throw new Error( `warm cache must not probe` )
                },
            } )

            expect( result.results ).toEqual( [ {
                name: `codex`,
                status: `cached`,
                authenticated: true,
            } ] )
            expect( result.cache_context.credential_fingerprint )
                .toBe( credential_identity.fingerprint )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `skips an uncached non-TTY startup without probing or caching`, async () => {

        const fixture = startup_auth_fixture()
        fixture.input.isTTY = false
        let probed = false

        try {
            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: {},
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                run_auth_check: async () => {
                    probed = true
                },
            } )

            expect( probed ).toBe( false )
            expect( result ).toEqual( {
                results: [ {
                    name: `codex`,
                    status: `skipped`,
                    authenticated: false,
                    reason: `non-interactive startup`,
                } ],
                cache_context: null,
            } )
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents )
                .toEqual( {} )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `clears stale trust and never caches an unauthenticated probe`, async () => {

        const fixture = startup_auth_fixture()

        try {
            const credential_identity = fingerprint_agent_credentials( codex, fixture.creds_mounts )
            record_host_auth_success( `codex`, {
                credential_fingerprint: credential_identity.fingerprint,
                image_identity: `sha256:test-image`,
            }, {
                cache_path: fixture.cache_path,
                now: 0,
            } )

            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: {},
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                run_auth_check: async agent => ( {
                    name: agent.name,
                    status: `unauthenticated`,
                    authenticated: false,
                    reason: `login required`,
                } ),
            } )

            expect( result.results[0].status ).toBe( `unauthenticated` )
            expect( result.cache_context ).toBeNull()
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents )
                .toEqual( {} )
        } finally {
            fixture.cleanup()
        }

    } )

} )
