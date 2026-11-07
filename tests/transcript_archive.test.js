import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { archive_index_entry, archive_session_transcripts, start_transcript_archiver } from '../src/sessions/transcript_archive.js'

const session = { babysit_id: `b1`, agent: `codex`, pwd: `/work/repo`, started_at: `2026-11-07T10:00:00.000Z`, container_id: `c1`, image_id: `sha256:${ `a`.repeat( 64 ) }` }

describe( `transcript archive`, () => {

    it( `does nothing when the archive is off`, async () => {
        const calls = []
        expect( await archive_session_transcripts( session, { root: null, run_command: async ( ...call ) => calls.push( call ) } ) ).toBe( false )
        expect( calls ).toEqual( [] )
    } )

    it( `mirrors the state volumes read-only, offline, as the host user, and writes the index`, async () => {
        const root = mkdtempSync( join( tmpdir(), `babysit-archive-` ) )
        const calls = []
        expect( await archive_session_transcripts( session, { root, run_command: async ( ...call ) => calls.push( call ) } ) ).toBe( true )
        const [ [ , args ] ] = calls
        const line = args.join( ` ` )
        expect( line ).toContain( `--network none` )
        expect( line ).toMatch( /-v babysit-codex-sessions-[a-f0-9]{12}:\/src\/0:ro/ )
        expect( line ).toMatch( /-v babysit-codex-sqlite-[a-f0-9]{12}:\/src\/1:ro/ )
        expect( line ).toContain( `${ join( root, `volumes` ) }:/archive` )
        expect( args ).toContain( session.image_id )
        const index = JSON.parse( readFileSync( join( root, `sessions`, `b1.json` ), `utf8` ) )
        expect( index ).toMatchObject( { babysit_id: `b1`, agent: `codex`, workspace: `/work/repo` } )
        expect( index.transcripts[ 0 ] ).toMatch( /^volumes\/babysit-codex-sessions-/ )
        rmSync( root, { recursive: true, force: true } )
    } )

    it( `copies a sandbox's state out of its container and drops credential files`, async () => {
        const root = mkdtempSync( join( tmpdir(), `babysit-archive-` ) )
        const sandbox = { ...session, agent: `opencode`, modifiers: [ `sandbox` ] }
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args )
            // Simulate docker cp landing the state, auth file included
            const out = args.at( -1 )
            mkdirSync( join( out, `storage` ), { recursive: true } )
            writeFileSync( join( out, `auth.json` ), `{}` )
            writeFileSync( join( out, `storage`, `message.json` ), `{}` )
        }
        await archive_session_transcripts( sandbox, { root, run_command } )
        expect( calls[ 0 ] ).toContain( `c1:/home/node/.local/share/opencode/.` )
        const out = join( root, `sandbox`, `b1`, `opencode` )
        expect( existsSync( join( out, `auth.json` ) ) ).toBe( false )
        expect( existsSync( join( out, `storage`, `message.json` ) ) ).toBe( true )
        expect( archive_index_entry( sandbox, [ { target: `/home/node/.local/share/opencode` } ] ).transcripts ).toEqual( [ `sandbox/b1/opencode` ] )
        rmSync( root, { recursive: true, force: true } )
    } )

    it( `the archiver never overlaps runs and stop awaits the one in flight`, async () => {
        let active = 0
        let peak = 0
        let runs = 0
        const archive = async () => {
            active++
            runs++
            peak = Math.max( peak, active )
            await new Promise( resolve => setTimeout( resolve, 20 ) )
            active--
        }
        const archiver = start_transcript_archiver( session, { archive, interval_ms: 5 } )
        archiver.run()
        await new Promise( resolve => setTimeout( resolve, 60 ) )
        await archiver.stop()
        expect( peak ).toBe( 1 )
        expect( runs ).toBeGreaterThan( 1 )
        expect( active ).toBe( 0 )
    } )

} )
