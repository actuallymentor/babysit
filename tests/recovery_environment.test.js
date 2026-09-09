import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { close_session, recover_session } from '../src/cli/recover.js'
import { get_host_codex_auth_file } from '../src/agents/codex.js'

const keys = [ `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GEMINI_CLI_HOME`, `OPENCODE_CONFIG_DIR` ]
const cleanups = []
afterEach( () => cleanups.splice( 0 ).reverse().forEach( cleanup => cleanup() ) )

const fixture = () => {

    const directory = mkdtempSync( join( tmpdir(), `babysit-recovery-environment-` ) )
    const original = Object.fromEntries( keys.map( key => [ key, process.env[ key ] ] ) )
    cleanups.push( () => {
        keys.forEach( key => {
            if( original[ key ] === undefined ) delete process.env[ key ]
            else process.env[ key ] = original[ key ]
        } )
        rmSync( directory, { recursive: true, force: true } )
    } )
    const caller_home = join( directory, `caller` )
    const saved_home = join( directory, `saved` )
    for( const home of [ caller_home, saved_home ] ) {
        mkdirSync( home )
        writeFileSync( join( home, `auth.json` ), `original` )
    }
    process.env.CODEX_HOME = caller_home
    process.env.CLAUDE_CONFIG_DIR = join( directory, `caller-claude` )
    delete process.env.GEMINI_CLI_HOME
    delete process.env.OPENCODE_CONFIG_DIR
    const caller = Object.fromEntries( keys.map( key => [ key, process.env[ key ] ] ) )
    const environment = { CODEX_HOME: saved_home, GEMINI_CLI_HOME: join( directory, `saved-gemini` ) }
    const session = {
        babysit_id: `launch`, agent: `codex`, pwd: directory, host: hostname(),
        recovery_version: 1, expected_open: true, status: `active`,
        docker_id: `daemon`, container_id: `container`, tmux_session: `pane`,
        launch_spec: { environment },
    }
    const dependencies = {
        load: () => session,
        update: ( id, fields ) => Object.assign( session, fields ),
        lock: () => () => {},
        identity: async () => ( { docker_id: `daemon` } ),
        sessions: async () => [],
        monitor_alive: () => false,
        inspect: async () => null,
        stop: async () => {},
        durable_exit: async () => ( { exit_status: 0, interrupted: false, exited_at: new Date().toISOString() } ),
        reconcile: async () => {
            // Exercise the real credential resolver and destination on disk.
            await Promise.resolve()
            expect( process.env.CLAUDE_CONFIG_DIR ).toBeUndefined()
            expect( process.env.GEMINI_CLI_HOME ).toBe( environment.GEMINI_CLI_HOME )
            writeFileSync( get_host_codex_auth_file(), `refreshed` )
        },
    }
    const assert_restored = () => expect( Object.fromEntries( keys.map( key => [ key, process.env[ key ] ] ) ) ).toEqual( caller )
    const assert_destination = () => {
        expect( readFileSync( join( saved_home, `auth.json` ), `utf8` ) ).toBe( `refreshed` )
        expect( readFileSync( join( caller_home, `auth.json` ), `utf8` ) ).toBe( `original` )
        assert_restored()
    }
    return { session, dependencies, assert_destination, assert_restored }

}

describe( `saved recovery credential environment`, () => {

    it( `reconciles a native clean-exit receipt into the saved profile`, async () => {
        const f = fixture()
        expect( ( await recover_session( f.session, {}, f.dependencies ) ).status ).toBe( `closed` )
        f.assert_destination()
    } )

    it( `reconciles explicit close into the saved profile`, async () => {
        const f = fixture()
        await close_session( f.session, {}, f.dependencies )
        expect( f.session.expected_open ).toBe( false )
        f.assert_destination()
    } )

    it( `reconciles shutdown into the saved profile while preserving intent`, async () => {
        const f = fixture()
        await close_session( f.session, { shutdown: true }, f.dependencies )
        expect( f.session.expected_open ).toBe( true )
        f.assert_destination()
    } )

    for( const action of [ `recover`, `close` ] ) it( `restores the caller profile when ${ action } cleanup fails`, async () => {
        const f = fixture()
        f.dependencies.reconcile = async () => { throw new Error( `cleanup failed` ) }
        const operation = action === `recover` ? recover_session : close_session
        await expect( operation( f.session, {}, f.dependencies ) ).rejects.toThrow( `cleanup failed` )
        f.assert_restored()
    } )

} )
