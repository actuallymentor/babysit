import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { CHECK_TRANSCRIPT, verify_session_transcript, refresh_durable_identity, read_durable_exit } from '../src/sessions/transcript.js'

let directory
beforeEach( () => {
    directory = mkdtempSync( join( tmpdir(), `babysit-transcripts-` ) )
} )
afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

const fixture = ( file, content ) => {
    const path = join( directory, file )
    mkdirSync( dirname( path ), { recursive: true } )
    writeFileSync( path, typeof content === `string` ? content : JSON.stringify( content ) )
    return path
}
const check = ( agent, id ) => {
    const script = CHECK_TRANSCRIPT.replace( `pathlib.Path('/home/node')`, `pathlib.Path(${ JSON.stringify( directory ) })` )
    const result = spawnSync( `python3`, [ `-c`, script, agent, id ], { encoding: `utf8` } )
    expect( result.stderr ).toBe( `` )
    return result.status === 0
}

describe( `exact native transcript verification`, () => {

    it( `requires Claude conversation metadata, excluding empty files and child transcripts`, () => {
        fixture( `.claude/projects/-workspace/root.jsonl`, `` )
        expect( check( `claude`, `root` ) ).toBe( false )
        fixture( `.claude/projects/-workspace/root.jsonl`, { type: `user`, sessionId: `other` } )
        expect( check( `claude`, `root` ) ).toBe( false )
        fixture( `.claude/projects/-workspace/root.jsonl`, { type: `user`, sessionId: `root`, isSidechain: true } )
        expect( check( `claude`, `root` ) ).toBe( false )
        fixture( `.claude/projects/-workspace/root.jsonl`, `${ JSON.stringify( { type: `queue-operation`, sessionId: `root` } ) }\n${ JSON.stringify( { type: `user`, sessionId: `root`, isSidechain: false } ) }\n` )
        expect( check( `claude`, `root` ) ).toBe( true )
    } )

    it( `requires exact Codex root metadata and rejects malformed payloads and symlinks`, () => {
        const file = fixture( `.codex/sessions/2026/09/09/rollout-date-root.jsonl`, { type: `session_meta`, payload: { id: `root`, source: { subagent: `root` } } } )
        expect( check( `codex`, `root` ) ).toBe( false )
        writeFileSync( file, JSON.stringify( { type: `session_meta`, payload: null } ) )
        expect( check( `codex`, `root` ) ).toBe( false )
        writeFileSync( file, JSON.stringify( { type: `session_meta`, payload: { id: `root`, source: `vscode` } } ) )
        expect( check( `codex`, `root` ) ).toBe( true )
        const other = fixture( `other`, readFileSync( file ) .toString() )
        rmSync( file )
        symlinkSync( other, file )
        expect( check( `codex`, `root` ) ).toBe( false )
    } )

    it( `requires Antigravity exact native CLI trajectory data rather than transcript filenames`, () => {
        const file = join( directory, `.gemini/antigravity-cli/conversations/root.db` )
        mkdirSync( join( directory, `.gemini/antigravity-cli/conversations` ), { recursive: true } )
        const setup = spawnSync( `python3`, [ `-c`, `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
 db.execute('CREATE TABLE trajectory_meta (cascade_id TEXT, source INTEGER)')
 db.execute('CREATE TABLE steps (idx INTEGER)')
 db.execute('INSERT INTO trajectory_meta VALUES (?, ?)', ('root', 17))
 db.execute('INSERT INTO steps VALUES (0)')`, file ] )
        expect( setup.status ).toBe( 0 )
        expect( check( `antigravity`, `root` ) ).toBe( true )
        expect( check( `antigravity`, `roo` ) ).toBe( false )
        spawnSync( `python3`, [ `-c`, `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db: db.execute('UPDATE trajectory_meta SET source = 16')`, file ] )
        expect( check( `antigravity`, `root` ) ).toBe( false )
        rmSync( file )
        fixture( `.gemini/antigravity-cli/brain/root/.system_generated/logs/transcript.jsonl`, { type: `USER_INPUT`, content: `Hi` } )
        expect( check( `antigravity`, `root` ) ).toBe( false )
    } )

    it( `validates OpenCode legacy JSON instead of trusting a filename`, () => {
        const file = fixture( `.local/share/opencode/storage/session/project/ses_root.json`, { id: `ses_root`, parentID: `ses_parent` } )
        expect( check( `opencode`, `ses_root` ) ).toBe( false )
        writeFileSync( file, JSON.stringify( { id: `ses_root` } ) )
        expect( check( `opencode`, `ses_root` ) ).toBe( true )
    } )

    it( `reads OpenCode SQLite WAL from a copy without creating source sidecars`, () => {
        const file = join( directory, `.local/share/opencode/opencode.db` )
        mkdirSync( dirname( file ), { recursive: true } )
        // os._exit simulates power loss: committed rows live only in the WAL.
        const setup = spawnSync( `python3`, [ `-c`, `import sqlite3,os,sys
file=sys.argv[1]
db=sqlite3.connect(file)
db.execute('PRAGMA journal_mode=WAL')
db.execute('CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT)')
db.execute('INSERT INTO session VALUES (?, NULL)', ('ses_root',))
db.execute('INSERT INTO session VALUES (?, ?)', ('ses_child', 'ses_root'))
db.commit()
os._exit(0)`, file ] )
        expect( setup.status ).toBe( 0 )
        rmSync( `${ file }-shm`, { force: true } )
        const original = readFileSync( file )
        const wal = readFileSync( `${ file }-wal` )
        expect( check( `opencode`, `ses_root` ) ).toBe( true )
        expect( check( `opencode`, `ses_child` ) ).toBe( false )
        expect( check( `opencode`, `ses_missing` ) ).toBe( false )
        expect( existsSync( `${ file }-shm` ) ).toBe( false )
        expect( readFileSync( file ) ).toEqual( original )
        expect( readFileSync( `${ file }-wal` ) ).toEqual( wal )
    } )

    it( `checks existing volume names before running an isolated read-only probe`, async () => {
        const calls = []
        const session = { agent: `codex`, agent_session_id: `root`, original_pwd: directory, image_id: `sha256:${ `a`.repeat( 64 ) }` }
        await verify_session_transcript( session, { run_command: async ( command, args ) => {
            calls.push( args )
        } } )
        expect( calls[ 0 ] ).toContain( `inspect` )
        expect( calls[ 1 ] ).toContain( `--read-only` )
        expect( calls[ 1 ] ).toContain( `/tmp:rw,nosuid,nodev,size=512m` )
        expect( calls[ 1 ].filter( value => value.endsWith( `:ro` ) ) ).toHaveLength( 2 )
        expect( calls[ 1 ].at( -1 ) ).toBe( `root` )
    } )

} )


describe( `durable root identity`, () => {

    it( `validates launch-scoped exit receipts without interpreting interruption as clean`, async () => {
        const launch_id = `11111111-1111-1111-1111-111111111111`
        const session = { agent: `codex`, original_pwd: directory, image_id: `sha256:${ `a`.repeat( 64 ) }`, completion_capture: { launch_id } }
        let record = { version: 1, agent: `codex`, launch_id, exit_status: 0, interrupted: true, exited_at: `2026-09-09T12:00:00Z` }
        const run_command = async ( command, args ) => {
            if( args.includes( `inspect` ) ) return ``
            expect( args.at( -1 ) ).toBe( `.exit` )
            return JSON.stringify( record )
        }
        expect( ( await read_durable_exit( session, { run_command } ) ).interrupted ).toBe( true )
        record = { ...record, interrupted: false }
        expect( ( await read_durable_exit( session, { run_command } ) ).interrupted ).toBe( false )
        record = { ...record, exit_status: 256 }
        await expect( read_durable_exit( session, { run_command } ) ).rejects.toThrow( `Invalid durable session exit` )
    } )


    it( `reads the launch mirror through the actual bounded Python program`, async () => {
        const launch_id = `11111111-1111-1111-1111-111111111111`
        const identity = { version: 1, agent: `codex`, launch_id, session_id: `new-root`, captured_at: `2026-09-09T12:00:00Z` }
        const file = fixture( `.babysit-identities/${ launch_id }.json`, identity )
        const session = { agent: `codex`, original_pwd: directory, image_id: `sha256:${ `a`.repeat( 64 ) }`, completion_capture: { launch_id } }
        const run_command = async ( command, args ) => {
            if( args.includes( `inspect` ) ) return ``
            const script = args[ args.indexOf( `-c` ) + 1 ]
            const result = spawnSync( `python3`, [ `-c`, script, directory, launch_id, args.at( -1 ) ], { encoding: `utf8` } )
            if( result.status ) throw new Error( `Probe failed` )
            return result.stdout
        }
        expect( await refresh_durable_identity( session, { run_command } ) ).toEqual( identity )
        writeFileSync( file, JSON.stringify( { ...identity, launch_id: `other` } ) )
        await expect( refresh_durable_identity( session, { run_command } ) ).rejects.toThrow( `Invalid durable session receipt` )
        rmSync( file )
        expect( await refresh_durable_identity( session, { run_command } ) ).toBeNull()
        const other = fixture( `other`, identity )
        symlinkSync( other, file )
        await expect( refresh_durable_identity( session, { run_command } ) ).rejects.toThrow( `Probe failed` )
    } )

} )
