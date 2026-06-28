import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { build_system_prompt } from '../src/modes/prompt.js'
import { load_monitor_config } from '../src/cli/monitor.js'
import {
    is_initial_prompt_ready,
    read_startup_log_tail,
    resolve_initial_prompt,
    startup_diagnostic_log_path,
    wait_for_initial_prompt_ready,
} from '../src/cli/start.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'

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
                modifiers: [ `yolo`, `docker`, `loop` ],
            } )

            expect( config.initial_prompt ).toContain( `AGENT_AUTONOMY_MODE=yolo` )
            expect( config.initial_prompt ).toContain( `Docker-outside-of-Docker is enabled` )
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
