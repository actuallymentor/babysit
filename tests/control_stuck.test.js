import { describe, expect, it } from 'bun:test'
import { create_stuck_controller, last_client_activity } from '../src/control/stuck.js'

const session = { babysit_id: `baby-1`, tmux_session: `babysit_one` }

describe( `babysit stuck controller`, () => {

    it( `flags once and clears when the user types after the flag`, async () => {
        const updates = []
        let clock = 1_000_000
        let typed_at = 500_000
        const controller = create_stuck_controller( session, {
            update: ( id, changes ) => updates.push( changes ),
            client_activity: async () => typed_at,
            now: () => clock,
            poll_ms: 5_000,
        } )

        expect( controller.request() ).toContain( `stuck` )
        controller.request()
        expect( controller.stuck ).toBe( true )
        expect( updates ).toEqual( [ { stuck_at: new Date( 1_000_000 ).toISOString() } ] )

        // Typing from before the flag does not count
        await controller.tick()
        expect( controller.stuck ).toBe( true )

        clock += 6_000
        typed_at = 1_003_000
        await controller.tick()
        expect( controller.stuck ).toBe( false )
        expect( updates.at( -1 ) ).toEqual( { stuck_at: null } )
    } )

    it( `polls clients only while stuck and no more than every poll interval`, async () => {
        let reads = 0
        let clock = 0
        const controller = create_stuck_controller( session, {
            update: () => {},
            client_activity: async () => {
                reads++
                return null
            },
            now: () => clock,
            poll_ms: 5_000,
        } )
        await controller.tick()
        controller.request()
        await controller.tick()
        await controller.tick()
        clock = 5_000
        await controller.tick()
        expect( reads ).toBe( 2 )
    } )

    it( `clears on web companion input and restores a stored flag`, () => {
        const updates = []
        const controller = create_stuck_controller( { ...session, stuck_at: `2026-10-06T12:00:00.000Z` }, { update: ( id, changes ) => updates.push( changes ) } )
        expect( controller.stuck ).toBe( true )
        controller.clear()
        controller.clear()
        expect( updates ).toEqual( [ { stuck_at: null } ] )
    } )

    it( `reads the newest client keypress time in milliseconds`, async () => {
        expect( await last_client_activity( `babysit_one`, { run_command: async () => `1791296318\n1791296400\n` } ) ).toBe( 1791296400_000 )
        expect( await last_client_activity( `babysit_one`, { run_command: async () => `` } ) ).toBeNull()
        expect( await last_client_activity( `babysit_one`, { run_command: async () => Promise.reject( new Error( `no server` ) ) } ) ).toBeNull()
    } )

} )
