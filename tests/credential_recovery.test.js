import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
    clear_credential_recovery,
    list_credential_recoveries,
    register_credential_recovery,
} from '../src/credentials/recovery.js'

describe( `credential recovery registry`, () => {

    it( `protects retained sync paths until ownership is explicitly cleared`, () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-recovery-registry-test-` ) )
        const container_id = `a`.repeat( 64 )
        const sync_paths = [
            join( tmpdir(), `babysit-creds-codex-recovery` ),
            join( tmpdir(), `babysit-creds-claude-recovery` ),
        ]

        try {
            const recovery_id = register_credential_recovery( {
                container_id,
                sync_paths,
            }, { directory } )

            expect( recovery_id ).toBe( container_id )
            expect( statSync( directory ).mode & 0o777 ).toBe( 0o700 )
            expect( list_credential_recoveries( { directory } ) ).toEqual( [
                expect.objectContaining( {
                    recovery_id,
                    container_id,
                    sync_paths,
                } ),
            ] )

            expect( clear_credential_recovery( recovery_id, { directory } ) ).toBe( true )
            expect( list_credential_recoveries( { directory } ) ).toEqual( [] )
            expect( existsSync( join( directory, `${ recovery_id }.json` ) ) ).toBe( false )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )
