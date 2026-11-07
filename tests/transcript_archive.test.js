import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { spawnSync } from 'child_process'

import { MIRROR_SCRIPT, archive_index_entry, archive_session_transcripts, start_transcript_archiver } from '../src/sessions/transcript_archive.js'

const session = { babysit_id: `b1`, agent: `codex`, pwd: `/work/repo`, started_at: `2026-11-07T10:00:00.000Z`, container_id: `c1`, image_id: `sha256:${ `a`.repeat( 64 ) }` }

describe( `transcript archive`, () => {

    it( `does nothing when the archive is off`, async () => {
        const calls = []
        expect( await archive_session_transcripts( session, { root: null, run_command: async ( ...call ) => calls.push( call ) } ) ).toBe( false )
        expect( calls ).toEqual( [] )
    } )

    it( `mirrors the state volumes offline, as the host user, and writes the index`, async () => {
        const root = mkdtempSync( join( tmpdir(), `babysit-archive-` ) )
        const calls = []
        expect( await archive_session_transcripts( session, { root, run_command: async ( ...call ) => calls.push( call ) } ) ).toBe( true )
        const [ [ , args ] ] = calls
        const line = args.join( ` ` )
        expect( line ).toContain( `--network none` )
        expect( line ).toMatch( /-v babysit-codex-sessions-[a-f0-9]{12}:\/src\/0 / )
        expect( line ).toMatch( /-v babysit-codex-sqlite-[a-f0-9]{12}:\/src\/1 / )
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
        const copy_out = async ( docker, source, out ) => {
            calls.push( source )
            // Simulate the unpacked copy landing, auth file included
            mkdirSync( join( out, `storage` ), { recursive: true } )
            writeFileSync( join( out, `auth.json` ), `{}` )
            writeFileSync( join( out, `storage`, `message.json` ), `{}` )
        }
        await archive_session_transcripts( sandbox, { root, copy_out } )
        expect( calls[ 0 ] ).toBe( `c1:/home/node/.local/share/opencode/.` )
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

    // The real generated script: filtering, SQLite snapshots, incremental passes
    it.skipIf( spawnSync( `python3`, [ `--version` ] ).status !== 0 )( `the mirror script skips credentials, snapshots SQLite in WAL mode, and copies only changes`, () => {
        const work = mkdtempSync( join( tmpdir(), `babysit-mirror-` ) )
        const source = join( work, `src` )
        const archive = join( work, `out` )
        mkdirSync( join( source, `nested` ), { recursive: true } )
        writeFileSync( join( source, `auth.json` ), `{"token":"secret"}` )
        writeFileSync( join( source, `.credentials.json` ), `{}` )
        writeFileSync( join( source, `nested`, `chat.jsonl` ), `{"role":"user"}\n` )
        const setup = `import sqlite3,sys\nd=sqlite3.connect(sys.argv[1]);d.execute('pragma journal_mode=wal');d.execute('create table t(x)');d.execute("insert into t values ('kept')");d.commit()\nimport os;os._exit(0)`
        expect( spawnSync( `python3`, [ `-c`, setup, join( source, `state.sqlite` ) ] ).status ).toBe( 0 )

        const mirror = () => spawnSync( `python3`, [ `-c`, MIRROR_SCRIPT, archive, source, `vol` ], { encoding: `utf8` } )
        const first = mirror()
        expect( first.status ).toBe( 0 )
        expect( first.stdout.trim() ).toBe( `2` )
        expect( existsSync( join( archive, `vol`, `auth.json` ) ) ).toBe( false )
        expect( existsSync( join( archive, `vol`, `.credentials.json` ) ) ).toBe( false )
        expect( readFileSync( join( archive, `vol`, `nested`, `chat.jsonl` ), `utf8` ) ).toContain( `user` )
        const read = `import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute('select x from t').fetchone()[0])`
        expect( spawnSync( `python3`, [ `-c`, read, join( archive, `vol`, `state.sqlite` ) ], { encoding: `utf8` } ).stdout.trim() ).toBe( `kept` )

        // Nothing changed: nothing copied
        expect( mirror().stdout.trim() ).toBe( `0` )
        rmSync( work, { recursive: true, force: true } )
    } )

} )
