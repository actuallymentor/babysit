import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import {
    default_babysit_config,
    normalise_auth_check_agents,
    read_babysit_config,
} from '../src/babysit/config.js'
import {
    cmd_config,
    format_auth_check_agents,
    parse_auth_check_agent_selection,
} from '../src/cli/config.js'

describe( `babysit config`, () => {

    it( `defaults auth checks to codex and claude`, () => {
        expect( default_babysit_config().auth_check_agents ).toEqual( [ `codex`, `claude` ] )
        expect( read_babysit_config( { config_path: `/tmp/does-not-exist-babysit-config.json` } ).auth_check_agents )
            .toEqual( [ `codex`, `claude` ] )
    } )

    it( `normalises auth-check agent selections`, () => {
        expect(
            normalise_auth_check_agents( [ `Codex`, `claude`, `codex`, `missing`, `` ] )
        ).toEqual( [ `codex`, `claude` ] )
        expect( normalise_auth_check_agents( `bad input` ) ).toEqual( [ `codex`, `claude` ] )
    } )

    it( `parses direct auth-check agent input`, () => {
        expect( parse_auth_check_agent_selection( `codex, gemini` ) ).toEqual( [ `codex`, `gemini` ] )
        expect( parse_auth_check_agent_selection( `all` ) ).toEqual( [ `claude`, `codex`, `gemini`, `opencode` ] )
        expect( parse_auth_check_agent_selection( `none` ) ).toEqual( [] )
        expect( parse_auth_check_agent_selection( ``, { current: [ `gemini` ] } ) ).toEqual( [ `gemini` ] )
        expect( () => parse_auth_check_agent_selection( `codex,missing` ) ).toThrow( /Unsupported agent/ )
    } )

    it( `formats auth-check agent lists`, () => {
        expect( format_auth_check_agents( [ `codex`, `claude` ] ) ).toBe( `codex, claude` )
        expect( format_auth_check_agents( [] ) ).toBe( `none` )
    } )

    it( `writes auth-check agents through the config command`, async () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-config-` ) )
        const config_path = join( dir, `config.json` )
        const output = new PassThrough()
        let rendered = ``

        output.on( `data`, chunk => {
            rendered += chunk.toString()
        } )

        try {
            await cmd_config( {
                flags: {
                    auth_check_agents: `gemini,opencode`,
                },
            }, {
                output,
                config_path,
            } )

            const saved = JSON.parse( readFileSync( config_path, `utf-8` ) )

            expect( saved.auth_check_agents ).toEqual( [ `gemini`, `opencode` ] )
            expect( rendered ).toBe( `Authentication checks: gemini, opencode\n` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }
    } )

    it( `shows non-tty config guidance without writing`, async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        let rendered = ``

        input.isTTY = false
        output.on( `data`, chunk => {
            rendered += chunk.toString()
        } )

        await cmd_config( { flags: {} }, { input, output } )

        expect( rendered ).toContain( `Authentication checks: codex, claude` )
        expect( rendered ).toContain( `babysit config --auth-check-agents codex,claude` )
    } )

} )
