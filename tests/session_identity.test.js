import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create_identity_reader } from '../src/sessions/identity.js'
import { run } from '../src/utils/exec.js'

const launch_id = `11111111-1111-1111-1111-111111111111`
const session = { agent: `claude`, container_id: `a`.repeat( 64 ), completion_capture: { launch_id, file: `/tmp/.babysit-completion-${ launch_id }/message.json` } }
const record = ( extra = {} ) => ( { version: 1, launch_id, agent: `claude`, session_id: `root`, captured_at: `2026-09-09T12:00:00Z`, ...extra } )
const encoded = value => Buffer.from( JSON.stringify( value ) ).toString( `base64` )
const cleanups = []
afterEach( () => cleanups.splice( 0 ).forEach( cleanup => cleanup() ) )

describe( `native identity reader`, () => {

    it( `reads the actual bounded descriptor program and rejects symlinks`, async () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-identity-` ) )
        cleanups.push( () => rmSync( directory, { recursive: true, force: true } ) )
        const file = join( directory, `identity.json` )
        const link = join( directory, `link.json` )
        writeFileSync( file, JSON.stringify( record() ) )
        symlinkSync( file, link )
        let target = file
        const reader = create_identity_reader( session, { run_command: ( command, args ) => {
            const index = args.indexOf( `node` )
            expect( args.at( -2 ) ).toEndWith( `/identity.json` )
            return run( `node`, [ ...args.slice( index + 1, -2 ), target, args.at( -1 ) ] )
        } } )
        cleanups.push( () => reader.close() )
        expect( await reader.refresh() ).toEqual( record() )
        target = link
        expect( await reader.refresh() ).toEqual( record() )
    } )

    it( `tracks authoritative root changes and ignores foreign, invalid and stale records`, async () => {
        let output = encoded( record() )
        const reader = create_identity_reader( session, { run_command: async () => output } )
        cleanups.push( () => reader.close() )
        expect( reader.read() ).toBeNull()
        expect( await reader.refresh() ).toEqual( record() )
        for( const invalid of [ { launch_id: `other` }, { agent: `codex` }, { session_id: `../escape` }, { captured_at: `bad` }, { captured_at: `2020-01-01` }, { version: 2 } ] ) {
            output = encoded( record( invalid ) )
            expect( await reader.refresh() ).toEqual( record() )
        }
        output = encoded( record( { session_id: `new-root`, captured_at: `2026-09-09T13:00:00Z` } ) )
        expect( ( await reader.refresh() ).session_id ).toBe( `new-root` )
    } )

    it( `shares pending reads and discards results arriving after close`, async () => {
        let finish
        let calls = 0
        const reader = create_identity_reader( session, { run_command: () => {
            calls++
            return new Promise( resolve => { finish = resolve } )
        } } )
        const first = reader.refresh()
        expect( reader.refresh() ).toBe( first )
        expect( calls ).toBe( 1 )
        reader.close()
        finish( encoded( record() ) )
        expect( await first ).toBeNull()
        expect( await reader.refresh() ).toBeNull()
    } )

    it( `never probes a legacy or malformed launch`, async () => {
        for( const candidate of [ {}, { ...session, container_id: `--help` }, { ...session, completion_capture: { launch_id, file: `/tmp/other` } } ] ) {
            let calls = 0
            const reader = create_identity_reader( candidate, { run_command: async () => { calls++ } } )
            expect( await reader.refresh() ).toBeNull()
            expect( calls ).toBe( 0 )
            reader.close()
        }
    } )

} )
