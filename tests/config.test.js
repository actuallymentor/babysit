import { describe, it, expect } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
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

    it( `keeps legacy auth selection readable for compatibility`, () => {
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
        expect( parse_auth_check_agent_selection( `codex, antigravity` ) ).toEqual( [ `codex`, `antigravity` ] )
        expect( parse_auth_check_agent_selection( `all` ) ).toEqual( [ `claude`, `codex`, `antigravity`, `opencode` ] )
        expect( parse_auth_check_agent_selection( `none` ) ).toEqual( [] )
        expect( parse_auth_check_agent_selection( ``, { current: [ `antigravity` ] } ) ).toEqual( [ `antigravity` ] )
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
                    auth_check_agents: `antigravity,opencode`,
                },
            }, {
                output,
                config_path,
            } )

            const saved = JSON.parse( readFileSync( config_path, `utf-8` ) )

            expect( saved.auth_check_agents ).toEqual( [ `antigravity`, `opencode` ] )
            expect( rendered ).toContain( `Legacy authentication selection saved: antigravity, opencode` )
            expect( rendered ).toContain( `deprecated` )
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

        expect( rendered ).toContain( `Startup authentication: active agent plus supported host-installed CLIs` )
        expect( rendered ).toContain( `babysit doctor --auth` )
        expect( rendered ).toContain( `Legacy authentication selection: codex, claude` )
    } )

    it( `prints effective CLI paths without creating settings or exposing credentials`, () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-config-status-` ) )
        const home = join( directory, `account` )
        const state = join( directory, `custom state` )
        const web = join( directory, `web` )
        const marker = join( home, `rc-was-sourced` )
        const secret = `do-not-print-this-test-secret`
        mkdirSync( home )
        writeFileSync( join( home, `.babysitrc` ), `touch '${ marker }'\nTOKEN=${ secret }\n` )
        const env = { ...process.env, HOME: home, BABYSIT_HOME: state,
            BABYSIT_WEB_BRIDGE_DIR: web, BABYSIT_TMUX_SOCKET: `config-test`,
            BABYSIT_DOCKER_IMAGE: `example/babysit:test`,
        }
        delete env.BABYSIT_HOST_BABYSITRC

        try {
            const run_config = () => execFileSync( process.execPath, [ `src/index.js`, `config` ], { env, encoding: `utf8` } )
            const output = run_config()
            for( const expected of [ `${ state } (BABYSIT_HOME)`, join( state, `sessions` ), join( state, `clones` ), web, `config-test`, `example/babysit:test`, `Recovery installed:` ] ) {
                expect( output ).toContain( expected )
            }
            expect( output ).not.toContain( secret )
            expect( existsSync( state ) ).toBe( false )
            expect( existsSync( web ) ).toBe( false )
            expect( existsSync( marker ) ).toBe( false )

            mkdirSync( state )
            writeFileSync( join( state, `launch-defaults.json` ), JSON.stringify( { global: { agent: `antigravity`, mode: `mudbox`, yolo: true } } ) )
            const configured = run_config()
            expect( configured ).toMatch( /Menu default agent:\s+antigravity/ )
            expect( configured ).toMatch( /Menu default mode:\s+mudbox/ )
            expect( configured ).toContain( `yolo on` )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }
    } )

} )
