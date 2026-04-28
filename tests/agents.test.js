import { describe, it, expect } from 'bun:test'
import { get_agent, SUPPORTED_AGENTS, is_agent } from '../src/agents/index.js'

describe( `agent registry`, () => {

    it( `supports four agents`, () => {
        expect( SUPPORTED_AGENTS ).toEqual( [ `claude`, `codex`, `gemini`, `opencode` ] )
    } )

    it( `returns null for unknown agent`, () => {
        expect( get_agent( `unknown` ) ).toBeNull()
    } )

    it( `identifies known agents`, () => {
        expect( is_agent( `claude` ) ).toBe( true )
        expect( is_agent( `invalid` ) ).toBe( false )
    } )

} )

describe( `agent adapter shape`, () => {

    for ( const name of SUPPORTED_AGENTS ) {

        describe( name, () => {

            const agent = get_agent( name )

            it( `has required fields`, () => {
                expect( agent.name ).toBe( name )
                expect( typeof agent.bin ).toBe( `string` )
                expect( agent.credentials ).toBeDefined()
                expect( agent.flags ).toBeDefined()
                expect( agent.session_id_pattern ).toBeInstanceOf( RegExp )
            } )

            it( `has skip_permissions flag`, () => {
                expect( typeof agent.flags.skip_permissions ).toBe( `function` )
            } )

            it( `has extra_env function`, () => {
                expect( typeof agent.extra_env ).toBe( `function` )
                expect( typeof agent.extra_env() ).toBe( `object` )
            } )

            it( `has credentials for both platforms`, () => {
                expect( agent.credentials.darwin ).toBeDefined()
                expect( agent.credentials.linux ).toBeDefined()
            } )

        } )

    }

} )
