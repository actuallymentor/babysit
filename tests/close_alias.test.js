import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmd_close } from '../src/cli/recover.js'
import { save_session, inspect_stored_sessions, load_session, update_session } from '../src/sessions/store.js'

it( `closes the current launch using the original ID printed by a failed boot sweep`, async () => {

    const directory = mkdtempSync( join( tmpdir(), `babysit-close-alias-` ) )
    const options = { directory }
    try {
        save_session( { babysit_id: `original`, expected_open: false, superseded_by: `retry` }, options )
        save_session( { babysit_id: `retry`, resumed_from: `original`, expected_open: false, superseded_by: `latest` }, options )
        save_session( { babysit_id: `latest`, resumed_from: `retry`, expected_open: true, status: `failed` }, options )
        const output = []
        await cmd_close( { session_id: `original` }, {
            inspect_records: () => inspect_stored_sessions( options ),
            close: session => update_session( session.babysit_id, { expected_open: false }, options ),
            print: message => output.push( message ),
        } )
        expect( load_session( `latest`, options ).expected_open ).toBe( false )
        expect( output ).toEqual( [ `Closed latest; it will not be recovered.` ] )
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }

} )
