import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { cleanup_stale_ephemeral_credential_mounts } from '../src/credentials/index.js'

describe( `ephemeral credential cleanup`, () => {

    it( `sweeps only abandoned GitHub credential transports`, () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-credential-sweep-test-` ) )
        const stale = join( directory, `babysit-gh-hosts.yml-stale` )
        const legacy_stale = join( directory, `babysit-gh-credentials.env-stale` )
        const fresh = join( directory, `babysit-gh-hosts.yml-fresh` )
        const unrelated = join( directory, `unrelated` )
        const now = Date.now()

        try {
            for( const path of [ stale, legacy_stale, fresh, unrelated ] ) mkdirSync( path )

            const old_time = new Date( now - 10_000 )
            utimesSync( stale, old_time, old_time )
            utimesSync( legacy_stale, old_time, old_time )

            expect( cleanup_stale_ephemeral_credential_mounts( {
                directory,
                now,
                max_age_ms: 1_000,
            } ) ).toBe( 2 )

            expect( existsSync( stale ) ).toBe( false )
            expect( existsSync( legacy_stale ) ).toBe( false )
            expect( existsSync( fresh ) ).toBe( true )
            expect( existsSync( unrelated ) ).toBe( true )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )
