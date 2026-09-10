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
