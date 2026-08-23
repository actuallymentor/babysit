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
    resolve_initial_prompt_ready_timeout,
    select_startup_auth_agents,
    should_confirm_startup_authentication,
    startup_diagnostic_log_path,
    wait_for_initial_prompt_ready,
} from '../src/cli/start.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { opencode } from '../src/agents/opencode.js'
import { SUPPORTED_AGENTS } from '../src/agents/index.js'
import {
    fingerprint_agent_credentials,
    read_host_auth_cache,
    record_host_auth_success,
} from '../src/agents/auth_cache.js'

const read_opencode_fixture = name => readFileSync(
    new URL( `./fixtures/opencode/${ name }.txt`, import.meta.url ),
    `utf8`
).replaceAll( `[ESC]`, `\x1b` )

const make_clock = () => {

    let current = 0

    return {
        advance: milliseconds => { current += milliseconds },
        now_fn: () => current,
        wait_fn: async milliseconds => { current += milliseconds },
    }

}

const deferred = () => {
    let resolve
    const promise = new Promise( resolve_promise => {
        resolve = resolve_promise
    } )

    return { promise, resolve }
}

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
        directory,
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
        expect( prompt ).toContain( `Google Chrome, Puppeteer, and Xvfb are preinstalled` )
        expect( prompt ).toContain( `pdfinfo` )
        expect( prompt ).toContain( `pdftotext` )
        expect( prompt ).toContain( `xvfb-run -a` )
        expect( prompt ).toContain( `Never add \`--no-sandbox\`` )
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

    it( `keeps the shorter readiness deadline scoped to Codex`, () => {
        expect( resolve_initial_prompt_ready_timeout( codex ) ).toBe( 15_000 )
        expect( resolve_initial_prompt_ready_timeout( claude ) ).toBe( 60_000 )
        expect( resolve_initial_prompt_ready_timeout( opencode ) ).toBe( 60_000 )
    } )

    it( `recognises Codex's usable composer screen`, () => {
        const output = `
>_ OpenAI Codex (v0.128.0)
model: gpt-5.6-sol
directory: /workspace
› Ask Codex to do anything
? for shortcuts
`
        expect( is_initial_prompt_ready( codex, output ) ).toBe( true )
    } )

    it( `recognises Codex when its optional footer is collapsed`, () => {
        expect( is_initial_prompt_ready( codex, `
OpenAI Codex
model: gpt-5.6-sol
directory: /workspace
› Ask Codex to do anything
` ) ).toBe( true )
    } )

    it( `recognises Codex when its banner has scrolled away`, () => {
        expect( is_initial_prompt_ready( codex, `
model: gpt-5.6-sol
directory: /workspace
› Ask Codex to do anything
` ) ).toBe( true )
    } )

    it( `rejects Codex's provisional composer while startup is loading`, () => {
        const output = `
>_ OpenAI Codex (v0.148.0)
model: loading
directory: loading or /workspace
› Ask Codex to do anything
? for shortcuts
`
        expect( is_initial_prompt_ready( codex, output ) ).toBe( false )
    } )

    it( `rejects Codex while only its model is loading`, () => {
        expect( is_initial_prompt_ready( codex, `
model: loading
directory: /workspace
› Ask Codex to do anything
` ) ).toBe( false )
    } )

    it( `rejects Codex while only its directory is loading`, () => {
        expect( is_initial_prompt_ready( codex, `
model: gpt-5.6-sol
directory: loading
› Ask Codex to do anything
` ) ).toBe( false )
    } )

    it( `does not treat Codex's bare banner as a ready composer`, () => {
        expect( is_initial_prompt_ready( codex, `>_ OpenAI Codex (v0.148.0)` ) ).toBe( false )
    } )

    it( `rejects Codex's update dialog even with a composer behind it`, () => {
        const output = `
>_ OpenAI Codex (v0.148.0)
? for shortcuts
› Ask Codex to do anything
Update available! 0.148.0 -> 0.149.0
Press enter to continue
`
        expect( is_initial_prompt_ready( codex, output ) ).toBe( false )
    } )

    for( const blocker of [
        `Do you trust the contents of this directory`,
        `Choose an approval mode`,
        `Sign in to Codex`,
    ] ) {
        it( `rejects Codex blocker: ${ blocker }`, () => {
            expect( is_initial_prompt_ready( codex, `
model: gpt-5.6-sol
directory: /workspace
› Ask Codex to do anything
${ blocker }
` ) ).toBe( false )
        } )
    }

    it( `recognises Claude's usable composer screen`, () => {
        const output = `
Claude Code v2.1.128
Welcome back Mentor!
❯
? for shortcuts
`
        expect( is_initial_prompt_ready( claude, output ) ).toBe( true )
    } )

    it( `does not require Claude's banner to use three-part semver`, () => {
        expect( is_initial_prompt_ready( claude, `Claude Code v3\n? for shortcuts` ) ).toBe( true )
    } )

    it( `does not treat Claude's splash screen as a ready composer`, () => {
        expect( is_initial_prompt_ready( claude, `Welcome to Claude Code v2.1.237` ) ).toBe( false )
    } )

    it( `rejects Claude's theme dialog even if its footer is visible`, () => {
        const output = `
Welcome to Claude Code v2.1.237
Choose the text style that looks best with your terminal
? for shortcuts
`
        expect( is_initial_prompt_ready( claude, output ) ).toBe( false )
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
        const captures = [
            `starting`,
            `still starting`,
            `OpenAI Codex\nmodel: ready\n› Ask Codex to do anything`,
        ]
        const clock = make_clock()

        const ready = await wait_for_initial_prompt_ready( `session`, codex, {
            capture: async ( session_name ) => {
                seen.push( session_name )
                return captures.shift()
            },
            has_session_fn: async () => true,
            wait_fn: async () => null,
            now_fn: clock.now_fn,
            timeout_ms: 750,
            interval_ms: 250,
        } )

        expect( ready ).toBe( true )
        expect( seen.length ).toBe( 3 )

    } )

    it( `returns false when the ready screen never appears`, async () => {

        const clock = make_clock()
        const ready = await wait_for_initial_prompt_ready( `session`, codex, {
            capture: async () => `loading`,
            wait_fn: clock.wait_fn,
            now_fn: clock.now_fn,
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
        const clock = make_clock()
        const ready = await wait_for_initial_prompt_ready( `session`, opencode, {
            capture: async () => captures.shift() || read_opencode_fixture( `model-error` ),
            wait_fn: clock.wait_fn,
            now_fn: clock.now_fn,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( false )

    } )

    it( `retries a transient pane capture failure`, async () => {

        const clock = make_clock()
        let captures = 0
        const ready = await wait_for_initial_prompt_ready( `session`, claude, {
            capture: async () => {
                captures++
                if( captures === 1 ) throw new Error( `tmux is busy` )
                return `Claude Code v3\n? for shortcuts`
            },
            has_session_fn: async () => true,
            wait_fn: clock.wait_fn,
            now_fn: clock.now_fn,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( true )
        expect( captures ).toBe( 2 )

    } )

    it( `stops retrying when the tmux session has exited`, async () => {

        const clock = make_clock()
        let liveness_checks = 0
        const ready = await wait_for_initial_prompt_ready( `session`, claude, {
            capture: async () => { throw new Error( `no pane` ) },
            has_session_fn: async () => {
                liveness_checks++
                return false
            },
            wait_fn: async () => null,
            now_fn: clock.now_fn,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( false )
        expect( liveness_checks ).toBe( 1 )

    } )

    it( `uses an absolute deadline even when pane capture is slow`, async () => {

        const clock = make_clock()
        const capture_timeouts = []
        const debug_messages = []
        let captures = 0
        const ready = await wait_for_initial_prompt_ready( `session`, codex, {
            capture: async ( _, capture_timeout_ms ) => {
                captures++
                capture_timeouts.push( capture_timeout_ms )
                clock.advance( 250 )
                return `\x1b[31mOpenAI Codex\x1b[0m\nmodel: loading\n? for shortcuts`
            },
            debug: message => debug_messages.push( message ),
            wait_fn: async () => null,
            now_fn: clock.now_fn,
            timeout_ms: 500,
            interval_ms: 250,
        } )

        expect( ready ).toBe( false )
        expect( captures ).toBe( 2 )
        expect( capture_timeouts ).toEqual( [ 500, 250 ] )
        expect( debug_messages ).toEqual( [
            `codex pane at initial-prompt readiness timeout:\nOpenAI Codex\nmodel: loading\n? for shortcuts`,
        ] )

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

    it( `keeps the active agent first and includes only installed host CLIs`, () => {

        const checked_bins = []
        const selected = select_startup_auth_agents( codex, {
            candidates: [ claude, codex, opencode, claude ],
            is_installed: candidate => {
                checked_bins.push( candidate.bin )
                return candidate.name !== `opencode`
            },
        } )

        expect( selected.map( agent => agent.name ) ).toEqual( [ `codex`, `claude` ] )
        expect( checked_bins ).toEqual( [ `claude`, `opencode` ] )

    } )

    it( `checks the active image agent without requiring a host binary`, () => {
        const selected = select_startup_auth_agents( codex, {
            candidates: [ codex ],
            is_installed: () => { throw new Error( `active agent must not be detected` ) },
        } )

        expect( selected ).toEqual( [ codex ] )
    } )

    it( `suppresses the exit prompt after the user skips the auth batch`, () => {
        const mixed_results = [
            { name: `opencode`, status: `failed`, authenticated: false },
            { name: `codex`, status: `skipped`, authenticated: false },
        ]

        expect( should_confirm_startup_authentication( mixed_results, true ) ).toBe( false )
        expect( should_confirm_startup_authentication( mixed_results, false ) ).toBe( true )
    } )

    it( `checks the active agent and installed host CLIs with scoped credentials`, async () => {

        const fixture = startup_auth_fixture()
        const checked_agents = []
        const reconciled_agents = []

        try {
            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: { yolo: true },
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                resolve_context_files: () => ( {} ),
                run_auth_check: async ( agent, options ) => {
                    checked_agents.push( agent.name )
                    expect( options.signal ).toBeInstanceOf( AbortSignal )
                    expect( options.creds_mounts ).toEqual(
                        agent.name === `codex` ? fixture.creds_mounts : []
                    )
                    return {
                        name: agent.name,
                        status: `authenticated`,
                        authenticated: true,
                    }
                },
                is_host_cli_installed: () => true,
                reconcile_credentials: async name => reconciled_agents.push( name ),
            } )

            const active_first_agents = [ `codex`, ...SUPPORTED_AGENTS.filter( name => name !== `codex` ) ]
            expect( checked_agents ).toEqual( active_first_agents )
            expect( reconciled_agents ).toEqual( active_first_agents )
            expect( result.results.every( item => item.status === `authenticated` ) ).toBe( true )
            expect( result.cache_context.image_identity ).toBe( `sha256:test-image` )
            expect( Object.keys( result.cache_contexts ) ).toEqual( [ `codex` ] )
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents.codex )
                .toBeDefined()
            expect( fixture.raw_modes ).toEqual( [ true, false ] )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `uses a warm cache without probing`, async () => {

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
                resolve_context_files: () => ( {} ),
                run_auth_check: async () => {
                    throw new Error( `warm cache must not probe` )
                },
                agents: [ codex ],
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

    it( `ignores warm auth state for an uninstalled non-active CLI`, async () => {

        const fixture = startup_auth_fixture()
        const opencode_mount = {
            type: `synced_file`,
            source: fixture.credential_path,
            target: opencode.container_paths.creds,
        }
        const creds_mounts = [ ...fixture.creds_mounts, opencode_mount ]
        const opencode_identity = fingerprint_agent_credentials( opencode, creds_mounts, {
            context_values: opencode.auth_check.cache_context( [], {
                workspace: `/tmp/project`,
            } ),
        } )
        const resolved_context = []
        const checked = []

        try {
            record_host_auth_success( `opencode`, {
                credential_fingerprint: opencode_identity.fingerprint,
                image_identity: `sha256:test-image`,
            }, { cache_path: fixture.cache_path } )

            const result = await check_startup_agent_authentication( codex, {
                workspace: `/tmp/project`,
                mode: {},
                creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                resolve_context_files: ( _, { agent } ) => {
                    resolved_context.push( agent.name )
                    return {}
                },
                run_auth_check: async agent => {
                    checked.push( agent.name )
                    return { name: agent.name, status: `authenticated`, authenticated: true }
                },
                agents: [ codex, opencode ],
                is_host_cli_installed: agent => agent.name !== `opencode`,
            } )

            expect( result.results.map( item => item.name ) ).toEqual( [ `codex` ] )
            expect( resolved_context ).toEqual( [ `codex` ] )
            expect( checked ).toEqual( [ `codex` ] )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `probes only misses while preserving agent order and one image lookup`, async () => {

        const fixture = startup_auth_fixture()
        const agents = [ claude, codex ]
        const credential_identity = fingerprint_agent_credentials( codex, fixture.creds_mounts )
        const probed = []
        let image_lookups = 0

        try {
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
                resolve_context_files: () => ( {} ),
                resolve_image_identity: async () => {
                    image_lookups += 1
                    return `sha256:test-image`
                },
                run_auth_check: async checked_agent => {
                    probed.push( checked_agent.name )
                    return {
                        name: checked_agent.name,
                        status: `authenticated`,
                        authenticated: true,
                    }
                },
                agents,
                is_host_cli_installed: () => true,
            } )

            expect( image_lookups ).toBe( 1 )
            expect( probed ).toEqual( [ `claude` ] )
            expect( result.results.map( item => `${ item.name }:${ item.status }` ) ).toEqual( [
                `codex:cached`,
                `claude:authenticated`,
            ] )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `runs an uncached non-TTY startup probe and caches success`, async () => {

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
                resolve_context_files: () => ( {} ),
                run_auth_check: async () => {
                    probed = true
                    return {
                        name: `codex`,
                        status: `authenticated`,
                        authenticated: true,
                    }
                },
                agents: [ codex ],
            } )

            expect( probed ).toBe( true )
            expect( result.results[0].status ).toBe( `authenticated` )
            expect( result.cache_context ).not.toBeNull()
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents.codex )
                .toBeDefined()
            expect( fixture.raw_modes ).toEqual( [] )
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
                resolve_context_files: () => ( {} ),
                run_auth_check: async agent => ( {
                    name: agent.name,
                    status: `unauthenticated`,
                    authenticated: false,
                    reason: `login required`,
                } ),
                agents: [ codex ],
            } )

            expect( result.results[0].status ).toBe( `unauthenticated` )
            expect( result.cache_context ).toBeNull()
            expect( read_host_auth_cache( { cache_path: fixture.cache_path } ).agents )
                .toEqual( {} )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `invalidates OpenCode auth trust when its effective model changes`, async () => {

        const fixture = startup_auth_fixture()
        fixture.input.isTTY = false
        const observed_models = []
        const route_path = join( fixture.directory, `opencode.json` )
        const opencode_creds_mounts = [ {
            type: `synced_file`,
            source: fixture.credential_path,
            target: opencode.container_paths.creds,
        } ]

        const check = agent_args => check_startup_agent_authentication( opencode, {
            workspace: fixture.directory,
            mode: {},
            creds_mounts: opencode_creds_mounts,
            input: fixture.input,
            output: fixture.output,
            cache_path: fixture.cache_path,
            resolve_image_identity: async () => `sha256:test-image`,
            resolve_context_files: () => ( {} ),
            run_auth_check: async ( agent, options ) => {
                observed_models.push( options.agent_args.at( -1 ) )
                return {
                    name: agent.name,
                    status: `authenticated`,
                    authenticated: true,
                }
            },
            agents: [ opencode ],
            agent_args,
        } )

        try {
            writeFileSync( route_path, `{ "provider": { "custom": { "options": { "baseURL": "https://first.example" } } } }` )
            await check( [ `--model`, `openai/first` ] )
            await check( [ `--model`, `openai/first` ] )
            writeFileSync( route_path, `{ "provider": { "custom": { "options": { "baseURL": "https://changed.example" } } } }` )
            await check( [ `--model`, `openai/first` ] )
            await check( [ `--model`, `anthropic/second` ] )

            expect( observed_models ).toEqual( [
                `openai/first`,
                `openai/first`,
                `anthropic/second`,
            ] )
        } finally {
            fixture.cleanup()
        }

    } )

    it( `rejects auth trust when route context changes during the probe`, async () => {

        const fixture = startup_auth_fixture()
        fixture.input.isTTY = false
        let context_reads = 0

        try {
            const result = await check_startup_agent_authentication( codex, {
                workspace: fixture.directory,
                mode: {},
                creds_mounts: fixture.creds_mounts,
                input: fixture.input,
                output: fixture.output,
                cache_path: fixture.cache_path,
                resolve_image_identity: async () => `sha256:test-image`,
                resolve_context_files: () => ( {} ),
                resolve_context_values: () => ( {
                    route: context_reads++ === 0 ? `before` : `after`,
                } ),
                run_auth_check: async () => ( {
                    name: `codex`,
                    status: `authenticated`,
                    authenticated: true,
                } ),
                agents: [ codex ],
            } )

            expect( context_reads ).toBe( 2 )
            expect( result.results[0] ).toMatchObject( {
                status: `failed`,
                authenticated: false,
                reason: `authentication context changed during the check`,
            } )
            expect( result.cache_context ).toBeNull()
        } finally {
            fixture.cleanup()
        }

    } )

    it( `returns a batch skip even when another startup probe already failed`, async () => {

        const fixture = startup_auth_fixture()
        const opencode_failed = deferred()
        const task = check_startup_agent_authentication( codex, {
            workspace: `/tmp/project`,
            mode: {},
            creds_mounts: fixture.creds_mounts,
            input: fixture.input,
            output: fixture.output,
            cache_path: fixture.cache_path,
            resolve_image_identity: async () => `sha256:test-image`,
            resolve_context_files: () => ( {} ),
            agents: [ codex, opencode ],
            is_host_cli_installed: () => true,
            run_auth_check: async ( agent, { signal } ) => {
                if( agent.name === `opencode` ) {
                    opencode_failed.resolve()
                    return {
                        name: agent.name,
                        status: `failed`,
                        authenticated: false,
                        reason: `model rejected tool schema`,
                    }
                }

                await new Promise( resolve_abort => signal.addEventListener( `abort`, resolve_abort, { once: true } ) )
                return {
                    name: agent.name,
                    status: `skipped`,
                    authenticated: false,
                    reason: `skipped by user`,
                }
            },
        } )

        try {
            await opencode_failed.promise
            fixture.input.write( `\n` )

            const result = await task
            expect( result.skipped ).toBe( true )
            expect( result.results.map( item => `${ item.name }:${ item.status }` ) ).toEqual( [
                `codex:skipped`,
                `opencode:failed`,
            ] )
            expect( should_confirm_startup_authentication( result.results, result.skipped ) )
                .toBe( false )
        } finally {
            fixture.cleanup()
        }

    } )

} )
