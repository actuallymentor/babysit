import { describe, it, expect } from 'bun:test'
import { build_system_prompt } from '../src/modes/prompt.js'
import {
    is_initial_prompt_ready,
    resolve_initial_prompt,
    wait_for_initial_prompt_ready,
} from '../src/cli/start.js'
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
