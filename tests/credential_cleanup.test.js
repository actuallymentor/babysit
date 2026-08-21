import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { cleanup_stale_ephemeral_credential_mounts } from '../src/credentials/index.js'

describe( `ephemeral credential cleanup`, () => {

    it( `sweeps only abandoned private credential transports`, () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-credential-sweep-test-` ) )
        const stale = join( directory, `babysit-gh-hosts.yml-stale` )
        const legacy_stale = join( directory, `babysit-gh-credentials.env-stale` )
        const credential_env_stale = join( directory, `babysit-credentials-env-stale` )
        const chrome_seccomp_stale = join( directory, `babysit-chrome-chrome-seccomp.json-stale` )
        const synced_credential_stale = join( directory, `babysit-creds-codex-stale` )
        const opencode_config_stale = join( directory, `babysit-opencode-opencode.json-stale` )
        const protected_synced_credential = join( directory, `babysit-creds-claude-protected` )
        const fresh = join( directory, `babysit-gh-hosts.yml-fresh` )
        const unrelated = join( directory, `unrelated` )
        const now = Date.now()

        try {
            for( const path of [
                stale,
                legacy_stale,
                credential_env_stale,
                chrome_seccomp_stale,
                synced_credential_stale,
                opencode_config_stale,
                protected_synced_credential,
                fresh,
                unrelated,
            ] ) mkdirSync( path )

            const old_time = new Date( now - 10_000 )
            utimesSync( stale, old_time, old_time )
            utimesSync( legacy_stale, old_time, old_time )
            utimesSync( credential_env_stale, old_time, old_time )
            utimesSync( chrome_seccomp_stale, old_time, old_time )
            utimesSync( synced_credential_stale, old_time, old_time )
            utimesSync( opencode_config_stale, old_time, old_time )
            utimesSync( protected_synced_credential, old_time, old_time )

            expect( cleanup_stale_ephemeral_credential_mounts( {
                directory,
                now,
                max_age_ms: 1_000,
                protected_paths: [ protected_synced_credential ],
            } ) ).toBe( 6 )

            expect( existsSync( stale ) ).toBe( false )
            expect( existsSync( legacy_stale ) ).toBe( false )
            expect( existsSync( credential_env_stale ) ).toBe( false )
            expect( existsSync( chrome_seccomp_stale ) ).toBe( false )
            expect( existsSync( synced_credential_stale ) ).toBe( false )
            expect( existsSync( opencode_config_stale ) ).toBe( false )
            expect( existsSync( protected_synced_credential ) ).toBe( true )
            expect( existsSync( fresh ) ).toBe( true )
            expect( existsSync( unrelated ) ).toBe( true )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )
