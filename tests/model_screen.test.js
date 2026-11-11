import { describe, it, expect } from 'bun:test'
import { model_from_screen } from '../src/agents/model_screen.js'
import { set_session_model } from '../src/tmux/session.js'

const claude_header = `
 ▐▛███▛█   Claude Code v2.1.322
▝▜██████▀  Opus 5.5 · Claude API
 ▝▝   ▝▝   /workspace

❯ Try "write a test for <filepath>"
  yolo·docker
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`

const claude_statusline = `
● Done. The tests pass.

❯
  yolo·docker actuallymentor/babysit ⎇ main ◆ Sonnet 5.5
  ⏵⏵ bypass permissions on (shift+tab to cycle)`

const codex_footer = `
• ok
  Worked for 5s • 1:51 PM
› Ask Codex to do anything
  GPT-6.1-Sol default · /workspace · Reply ok
  ← for agents · ? for shortcuts`

describe( `model_from_screen`, () => {

    it( `reads Claude's header and its statusline`, () => {
        expect( model_from_screen( `claude`, claude_header ) ).toBe( `Opus 5.5` )
        expect( model_from_screen( `claude`, claude_statusline ) ).toBe( `Sonnet 5.5` )
    } )

    it( `ignores a model named in the conversation`, () => {
        expect( model_from_screen( `claude`, `● I switched from Opus 4 to Sonnet 5.5 for this.\n\n❯` ) ).toBeNull()
    } )

    it( `reads Codex's footer`, () => {
        expect( model_from_screen( `codex`, codex_footer ) ).toBe( `GPT-6.1-Sol` )
        expect( model_from_screen( `codex`, `› Ask Codex to do anything\n  ? for shortcuts` ) ).toBeNull()
    } )

    it( `knows nothing about other agents`, () => {
        expect( model_from_screen( `opencode`, codex_footer ) ).toBeNull()
    } )

} )

describe( `set_session_model`, () => {

    it( `publishes the model and the right-hand format`, async () => {
        const calls = []
        expect( await set_session_model( `babysit_x`, `Opus 5.5`, { run_command: async ( _, args ) => calls.push( args.slice( 2 ) ) } ) ).toBe( true )
        expect( calls[0] ).toEqual( [ `set-option`, `-t`, `=babysit_x:`, `@babysit_model`, `Opus 5.5` ] )
        expect( calls.map( call => call[3] ) ).toEqual( [ `@babysit_model`, `status-right`, `status-right-length` ] )
    } )

    it( `reports a tmux failure instead of throwing`, async () => {
        expect( await set_session_model( `babysit_x`, `m`, { run_command: async () => { throw new Error( `gone` ) } } ) ).toBe( false )
    } )

} )
