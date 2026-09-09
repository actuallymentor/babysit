import { describe, expect, it } from 'bun:test'
import { was_clean_native_exit } from '../src/cli/monitor.js'
import { get_boot_id } from '../src/sessions/lock.js'

const session = { recovery_version: 1, shutdown_boot_id: get_boot_id() }

describe( `native exit evidence during shutdown`, () => {

    it( `honors a clean receipt written before shutdown stamped the registry`, async () => {
        for( const marker of [ 0, null, 143 ] ) {
            expect( await was_clean_native_exit( session, marker, {
                read_exit: async () => ( { exit_status: 0, interrupted: false } ),
            } ) ).toBe( true )
        }
    } )

    it( `retains intent for interrupted zero exits even with a zero terminal marker`, async () => {
        for( const marker of [ 0, null, 143 ] ) {
            expect( await was_clean_native_exit( session, marker, {
                read_exit: async () => ( { exit_status: 0, interrupted: true } ),
            } ) ).toBe( false )
        }
    } )

    it( `does not infer clean closure from an absent receipt during shutdown`, async () => {
        expect( await was_clean_native_exit( session, 0, { read_exit: async () => null } ) ).toBe( false )
        expect( await was_clean_native_exit( { recovery_version: 1 }, null, { read_exit: async () => null } ) ).toBe( false )
    } )

    it( `uses a normal zero marker without a volume probe outside shutdown`, async () => {
        let probes = 0
        for( const shutdown_boot_id of [ undefined, null ] ) {
            expect( await was_clean_native_exit( { recovery_version: 1, shutdown_boot_id }, 0, { read_exit: async () => { probes++ } } ) ).toBe( true )
        }
        expect( probes ).toBe( 0 )
    } )

} )
