import { describe, it, expect } from 'bun:test'

import { execute_action } from '../src/babysit/actions.js'

describe( `special babysit actions`, () => {

    it( `maps accept to Enter`, async () => {

        const sent = []

        await execute_action( `session`, `accept`, {}, {
            send_enter_fn: session => sent.push( [ `enter`, session ] ),
            send_shift_tab_fn: session => sent.push( [ `shift_tab`, session ] ),
        } )

        expect( sent ).toEqual( [ [ `enter`, `session` ] ] )

    } )

    it( `keeps shift_tab as an explicit raw key action`, async () => {

        const sent = []

        await execute_action( `session`, `shift_tab`, {}, {
            send_enter_fn: session => sent.push( [ `enter`, session ] ),
            send_shift_tab_fn: session => sent.push( [ `shift_tab`, session ] ),
        } )

        expect( sent ).toEqual( [ [ `shift_tab`, `session` ] ] )

    } )

} )
