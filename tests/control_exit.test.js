import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { agent_status } from '../src/babysit/activity.js'
import { EXIT_COMMAND, EXIT_FALLBACK_MS, EXIT_TURN_LIMIT_MS, FORCE_ATTEMPTS, create_exit_controller, is_exit_dialog } from '../src/control/exit.js'

const fixture = name => readFileSync( new URL( `./fixtures/claude/${ name }`, import.meta.url ), `utf8` )
const EXIT_MENU = fixture( `exit-background-work-2.1.310.txt` )

const session = { babysit_id: `baby-1`, pane_id: `%3`, tmux_session: `babysit_one` }

const make = ( overrides = {} ) => {
    const calls = { sent: [], keys: [], updates: [], forced: 0, timers: [] }
    let clock = 0
    const controller = create_exit_controller( session, {
        send_text: async ( target, text ) => calls.sent.push( [ target, text ] ),
        send_keys: async ( target, key ) => calls.keys.push( [ target, key ] ),
        update: ( id, changes ) => calls.updates.push( [ id, changes ] ),
        force_close: async () => calls.forced++,
        set_timer: ( fn, ms ) => {
            const timer = { fn, ms, unref() {} }
            calls.timers.push( timer )
            return timer
        },
        clear_timer: timer => calls.timers.splice( calls.timers.indexOf( timer ), 1 ),
        now: () => clock,
        ...overrides,
    } )
    const advance = ms => clock += ms
    return { controller, calls, advance }
}

describe( `babysit exit controller`, () => {

    it( `marks the close intentional once and quits the agent when its composer is idle`, async () => {
        const { controller, calls } = make()

        expect( controller.request() ).toContain( `Exiting` )
        controller.request()
        expect( calls.updates ).toHaveLength( 1 )
        expect( calls.updates[0][0] ).toBe( `baby-1` )
        expect( calls.updates[0][1] ).toMatchObject( { expected_open: false, close_reason: `agent` } )

        await controller.on_status( `running` )
        expect( calls.sent ).toEqual( [] )
        await controller.on_status( `idle` )
        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [ [ `%3`, EXIT_COMMAND ] ] )
        expect( calls.keys ).toEqual( [] )
    } )

    it( `recognises Claude's background-work exit menu`, () => {
        expect( is_exit_dialog( EXIT_MENU ) ).toBe( true )
        expect( is_exit_dialog( `❯ Background work is running in the docs` ) ).toBe( false )
        expect( is_exit_dialog( `` ) ).toBe( false )
    } )

    it( `answers the exit menu with "exit and stop tasks", again only after a pause`, async () => {
        const { controller, calls, advance } = make()
        controller.request()
        await controller.on_status( `idle` )

        // The monitor reads this menu as running: its footer says "Esc to cancel"
        expect( agent_status( EXIT_MENU, `claude`, 30 ) ).toBe( `running` )
        await controller.on_status( `running`, EXIT_MENU )
        expect( calls.keys ).toEqual( [ [ `%3`, `1` ] ] )

        // Still drawn on the next tick: no key spam
        await controller.on_status( `idle`, EXIT_MENU )
        expect( calls.keys ).toHaveLength( 1 )

        advance( 5_000 )
        await controller.on_status( `idle`, EXIT_MENU )
        expect( calls.keys ).toHaveLength( 2 )
        expect( calls.sent ).toHaveLength( 1 )
    } )

    it( `waits for a long turn, then starts the grace period when /exit is sent`, async () => {
        const { controller, calls } = make()

        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [] )

        controller.request()
        expect( calls.timers.map( timer => timer.ms ) ).toEqual( [ EXIT_TURN_LIMIT_MS ] )

        await controller.on_status( `idle` )
        expect( calls.timers.map( timer => timer.ms ) ).toEqual( [ EXIT_FALLBACK_MS ] )

        await calls.timers[0].fn()
        expect( calls.forced ).toBe( 1 )

        // Forcing: the monitor stops typing into the pane
        await controller.on_status( `idle`, EXIT_MENU )
        expect( calls.keys ).toEqual( [] )
    } )

    it( `keeps the forced close armed when typing into the pane fails`, async () => {
        const fail = async () => {
            throw new Error( `tmux timed out` )
        }
        const { controller, calls } = make( { send_text: fail, send_keys: fail } )
        controller.request()

        await controller.on_status( `idle` )
        await controller.on_status( `running`, EXIT_MENU )
        expect( calls.timers.map( timer => timer.ms ) ).toEqual( [ EXIT_FALLBACK_MS ] )

        await calls.timers[0].fn()
        expect( calls.forced ).toBe( 1 )
    } )

    it( `retries a failing forced close, then gives up`, async () => {
        let attempts = 0
        const { controller, calls } = make( { force_close: async () => {
            attempts++
            throw new Error( `Session operation already in progress` )
        } } )
        controller.request()

        while( calls.timers.length ) await calls.timers.shift().fn()
        expect( attempts ).toBe( FORCE_ATTEMPTS )
    } )

    it( `cancels the fallback on stop, including a pending retry`, async () => {
        const { controller, calls } = make( { force_close: async () => {
            controller.stop()
            throw new Error( `boom` )
        } } )
        controller.request()
        expect( calls.timers ).toHaveLength( 1 )

        await calls.timers.shift().fn()
        expect( calls.timers ).toHaveLength( 0 )
    } )

} )
