import { describe, expect, it } from 'bun:test'
import { create_loop_controller } from '../src/control/loop.js'

const idle_rule = () => ( { on: { type: `idle` }, do: `./IDLE.md`, timeout_s: 30, last_fired_at: 0 } )

describe( `babysit loop toggle`, () => {

    it( `enables and disables looping across record, rules, and tmux label`, async () => {
        const session = { babysit_id: `b1`, tmux_session: `babysit_b1`, name: `feature`, pwd: `/w/app`, modifiers: [ `yolo` ] }
        const rules = [ idle_rule() ]
        const updates = []
        const labels = []
        const controller = create_loop_controller( session, {
            rules, workspace: `/w/app`,
            load_rules: () => [ idle_rule() ],
            update: ( id, changes ) => updates.push( changes.modifiers ),
            set_label: async ( name, label ) => labels.push( [ name, label ] ),
            apply: ( live, workspace ) => {
                live[0] = { ...live[0], do: `${ workspace }/LOOP.md` }
            },
        } )

        expect( controller.enabled ).toBe( false )
        expect( await controller.toggle() ).toBe( `Looping is now enabled.` )
        expect( controller.enabled ).toBe( true )
        expect( updates.at( -1 ) ).toEqual( [ `yolo`, `loop` ] )
        expect( rules[0].do ).toBe( `/w/app/LOOP.md` )
        expect( labels.at( -1 ) ).toEqual( [ `babysit_b1`, `feature · w/app · [yolo, loop]` ] )

        expect( await controller.toggle() ).toBe( `Looping is now disabled.` )
        expect( updates.at( -1 ) ).toEqual( [ `yolo` ] )
        expect( rules[0].do ).toBe( `./IDLE.md` )
        expect( labels.at( -1 )[1] ).toBe( `feature · w/app · [yolo]` )
    } )

    it( `survives a tmux label failure`, async () => {
        const session = { babysit_id: `b1`, tmux_session: `gone`, modifiers: [] }
        const controller = create_loop_controller( session, {
            rules: [], workspace: `/w`, load_rules: () => [], update: () => {},
            set_label: async () => {
                throw new Error( `no server` )
            },
            apply: () => {},
        } )
        expect( await controller.toggle() ).toBe( `Looping is now enabled.` )
    } )

} )
