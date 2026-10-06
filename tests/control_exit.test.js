import { describe, expect, it } from 'bun:test'
import { EXIT_COMMAND, create_exit_controller } from '../src/control/exit.js'

const session = { babysit_id: `baby-1`, pane_id: `%3`, tmux_session: `babysit_one` }

const make = ( overrides = {} ) => {
    const calls = { sent: [], updates: [], forced: 0, timers: [] }
    const controller = create_exit_controller( session, {
        send_text: async ( target, text ) => calls.sent.push( [ target, text ] ),
        update: ( id, changes ) => calls.updates.push( [ id, changes ] ),
        force_close: async () => calls.forced++,
        set_timer: fn => {
            calls.timers.push( fn )
            return { unref() {} }
        },
        clear_timer: () => calls.timers.splice( 0 ),
        ...overrides,
    } )
    return { controller, calls }
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
    } )

    it( `does nothing before a request and forces the close when the agent ignores it`, async () => {
        const { controller, calls } = make()

        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [] )

        controller.request()
        await calls.timers[0]()
        expect( calls.forced ).toBe( 1 )
    } )

    it( `cancels the fallback on stop`, () => {
        const { controller, calls } = make()
        controller.request()
        expect( calls.timers ).toHaveLength( 1 )
        controller.stop()
        expect( calls.timers ).toHaveLength( 0 )
    } )

} )
