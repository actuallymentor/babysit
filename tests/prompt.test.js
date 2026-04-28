import { describe, it, expect } from 'bun:test'
import { build_system_prompt } from '../src/modes/prompt.js'

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

    it( `does not embed sandbox text when sandbox is false`, () => {
        const prompt = build_system_prompt( { yolo: true } )
        expect( prompt ).not.toContain( `AGENT_AUTONOMY_MODE=sandbox` )
    } )

} )
