import { describe, expect, it } from 'bun:test'
import { create_reset_controller } from '../src/control/reset.js'
import { get_agent } from '../src/agents/index.js'

const session = { babysit_id: `baby-1`, pane_id: `%3`, tmux_session: `babysit_one` }

const make = ( overrides = {} ) => {
    const calls = { sent: [], waits: [], ready: 0 }
    const controller = create_reset_controller( session, {
        clear_command: `/clear`,
        prompt: async () => `Read the docs first`,
        send_text: async ( target, text ) => calls.sent.push( [ target, text ] ),
        wait_ready: async () => {
            calls.ready++
            return true
        },
        wait: async ms => calls.waits.push( ms ),
        ...overrides,
    } )
    return { controller, calls }
}

describe( `babysit reset controller`, () => {

    it( `waits for the turn to end, clears once, then resends the prompt`, async () => {
        const { controller, calls } = make()

        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [] )

        expect( controller.request() ).toContain( `Resetting` )
        await controller.on_status( `running` )
        await controller.on_status( `waiting` )
        expect( calls.sent ).toEqual( [] )

        await controller.on_status( `idle` )
        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [ [ `%3`, `/clear` ], [ `%3`, `Read the docs first` ] ] )
        expect( calls.ready ).toBe( 1 )
        expect( controller.requested ).toBe( false )
    } )

    it( `only clears when no initial prompt is configured`, async () => {
        const { controller, calls } = make( { prompt: async () => `` } )
        controller.request()
        await controller.on_status( `idle` )
        expect( calls.sent ).toEqual( [ [ `%3`, `/clear` ] ] )
    } )

    it( `skips the prompt when the composer never returns, and survives send errors`, async () => {
        const stuck = make( { wait_ready: async () => false } )
        stuck.controller.request()
        await stuck.controller.on_status( `idle` )
        expect( stuck.calls.sent ).toEqual( [ [ `%3`, `/clear` ] ] )

        const broken = make( { send_text: async () => {
            throw new Error( `no pane` )
        } } )
        broken.controller.request()
        await broken.controller.on_status( `idle` )
        expect( broken.controller.requested ).toBe( false )
    } )

    it( `refuses agents without a clear command`, () => {
        const { controller } = make( { clear_command: null } )
        expect( () => controller.request() ).toThrow( /not supported/ )
    } )

    it( `agent adapters declare their clear command`, () => {
        expect( get_agent( `claude` ).reset_command ).toBe( `/clear` )
        expect( get_agent( `codex` ).reset_command ).toBe( `/new` )
        expect( get_agent( `opencode` ).reset_command ).toBe( `/new` )
        expect( get_agent( `antigravity` ).reset_command ).toBeUndefined()
    } )

} )
