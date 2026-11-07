import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { STATE_READERS } from '../src/sessions/state_readers.js'

// Run a snippet after the shared helpers, as every inline reader does
const python = ( code, ...args ) => {
    const result = spawnSync( `python3`, [ `-c`, `${ STATE_READERS }\nimport sys\n${ code }`, ...args ], { encoding: `utf8` } )
    if( result.status !== 0 ) throw new Error( result.stderr )
    return JSON.parse( result.stdout )
}

describe( `shared native-state readers`, () => {

    let directory
    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-readers-` ) )
    } )
    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    it( `json_records skips oversized and invalid lines, honours its line limit and never follows symlinks`, () => {
        const file = join( directory, `log.jsonl` )
        writeFileSync( file, [ `{"n":1}`, `{"big":"${ `x`.repeat( 100 ) }"}`, `not json`, `[1]`, `{"n":2}`, `{"n":3}` ].join( `\n` ) + `\n` )
        symlinkSync( file, join( directory, `link.jsonl` ) )
        const read = ( name, args ) => python( `print(json.dumps(list(json_records(pathlib.Path(sys.argv[1]), ${ args }))))`, join( directory, name ) )
        expect( read( `log.jsonl`, `maximum=50` ) ).toEqual( [ { n: 1 }, { n: 2 }, { n: 3 } ] )
        expect( read( `log.jsonl`, `limit=5, maximum=50` ) ).toEqual( [ { n: 1 }, { n: 2 } ] )
        expect( read( `log.jsonl`, `limit=None` ) ).toHaveLength( 4 )
        expect( read( `link.jsonl`, `limit=None` ) ).toEqual( [] )
        expect( read( `missing.jsonl`, `limit=None` ) ).toEqual( [] )
    } )

    it( `codex_root_rollout accepts only a root CLI or vscode thread`, () => {
        const sessions = join( directory, `sessions` )
        mkdirSync( join( sessions, `2026/11/07` ), { recursive: true } )
        const meta = payload => writeFileSync( join( sessions, `2026/11/07/rollout-date-t1.jsonl` ), `${ JSON.stringify( { type: `session_meta`, payload } ) }\n` )
        const root = () => python( `print(json.dumps(codex_root_rollout(pathlib.Path(sys.argv[1]), 't1')))`, sessions )
        expect( root() ).toBe( false )
        meta( { id: `t1`, source: { subagent: `x` } } )
        expect( root() ).toBe( false )
        meta( { id: `t1`, source: `cli` } )
        expect( root() ).toBe( true )
    } )

    it( `isolated_sqlite reads a private copy and leaves no sidecars behind`, () => {
        const database = join( directory, `state.db` )
        python( `db = sqlite3.connect(sys.argv[1]); db.execute('CREATE TABLE t (v)'); db.execute("INSERT INTO t VALUES ('ok')"); db.commit(); print('1')`, database )
        const value = python( `
with isolated_sqlite(pathlib.Path(sys.argv[1])) as db: print(json.dumps(db.execute('SELECT v FROM t').fetchone()[0]))`, database )
        expect( value ).toBe( `ok` )
        expect( spawnSync( `ls`, [ directory ], { encoding: `utf8` } ).stdout.trim() ).toBe( `state.db` )
    } )

} )
