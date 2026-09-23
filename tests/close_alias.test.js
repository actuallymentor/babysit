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

it( `closes the numbered live session using list/open order, not stored history order`, async () => {
    const history = { babysit_id: `2`, tmux_session: `old`, expected_open: false }
    const first = { babysit_id: `first`, tmux_session: `babysit_first` }
    const second = { babysit_id: `second`, tmux_session: `babysit_second` }
    const closed = []
    await cmd_close( { session_id: `02` }, {
        inspect_records: () => ( { records: [ history, second, first ].map( session => ( { session } ) ) } ),
        sessions: async () => [ { name: first.tmux_session }, { name: second.tmux_session } ],
        close: session => closed.push( session ),
        print: () => {},
    } )
    expect( closed ).toEqual( [ second ] )
} )

it.each( [ `0`, `3`, `999999999999999999999` ] )( `rejects invalid session number %s without closing a stored ID`, async number => {
    const closed = []
    await expect( cmd_close( { session_id: number }, {
        inspect_records: () => ( { records: [ { session: { babysit_id: number } } ] } ),
        sessions: async () => [ { name: `babysit_first` } ],
        close: session => closed.push( session ),
        print: () => {},
    } ) ).rejects.toThrow( `No active session numbered` )
    expect( closed ).toEqual( [] )
} )

it( `does not skip a numbered live session with missing metadata`, async () => {
    const closed = []
    await expect( cmd_close( { session_id: `1` }, {
        inspect_records: () => ( { records: [ { session: { babysit_id: `other`, tmux_session: `babysit_other` } } ] } ),
        sessions: async () => [ { name: `babysit_missing` }, { name: `babysit_other` } ],
        close: session => closed.push( session ),
        print: () => {},
    } ) ).rejects.toThrow( `No stored session found for active session numbered 1` )
    expect( closed ).toEqual( [] )
} )
