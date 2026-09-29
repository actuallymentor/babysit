import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { BridgeStore } from '../server/bridge.js'

test( `queue cleanup tolerates the host claiming a request after directory enumeration`, () => {
    // The production server uses Node. Bun cannot replace named builtin exports
    // with syncBuiltinESMExports, so run this deterministic race under Node.
    if( process.versions.bun ) {
        execFileSync( `node`, [ `--test`, fileURLToPath( import.meta.url ) ], { stdio: `pipe` } )
        return
    }

    const directory = fs.mkdtempSync( join( tmpdir(), `babysit-claim-race-` ) )
    const filename = `session--epoch--123e4567-e89b-42d3-a456-426614174000.json`
    const request = join( directory, filename )
    fs.writeFileSync( request, `{}` )
    const store = new BridgeStore( {
        request_dir: directory, state_dir: directory,
        request_ttl_ms: 20_000, heartbeat_ttl_ms: 15_000,
    } )
    const read_directory = fs.readdirSync
    fs.readdirSync = ( ...args ) => {
        const entries = read_directory( ...args )
        // Reproduce the atomic host claim in the window before web-side stat.
        fs.renameSync( request, join( directory, `claimed` ) )
        return entries
    }
    syncBuiltinESMExports()

    try {
        assert.doesNotThrow( () => store.cleanup_pending() )
        assert.ok( fs.existsSync( join( directory, `claimed` ) ), `the monitor claim happened before stat` )
    } finally {
        fs.readdirSync = read_directory
        syncBuiltinESMExports()
        clearInterval( store.cleanup_timer )
        fs.rmSync( directory, { recursive: true, force: true } )
    }
} )

test( `orphan sweep leaves a tracked request whose file mtime predates its tracking`, () => {
    // On a slow disk the payload's mtime is written before fsync and rename,
    // while created_at is only set afterwards. Only the tracked-request TTL may
    // expire a request this process queued; the orphan sweep is for leftovers.
    const directory = fs.mkdtempSync( join( tmpdir(), `babysit-slow-fsync-` ) )
    const store = new BridgeStore( {
        request_dir: directory, state_dir: directory,
        request_ttl_ms: 500, heartbeat_ttl_ms: 15_000,
    } )
    clearInterval( store.cleanup_timer )

    try {
        const session = { session_id: `session-1`, epoch: `epoch-1` }
        const { request_id } = store.send( { session, text: `hello` } )
        const [ filename ] = fs.readdirSync( directory )
        const stale = new Date( Date.now() - 2_000 )
        fs.utimesSync( join( directory, filename ), stale, stale )

        store.cleanup_pending()

        assert.ok( fs.existsSync( join( directory, filename ) ), `tracked request file survives the orphan sweep` )
        assert.deepEqual( store.pending_for( { session_id: `session-1`, results: [] } ), [ { message: undefined, request_id, status: `pending` } ] )
    } finally {
        fs.rmSync( directory, { recursive: true, force: true } )
    }
} )
