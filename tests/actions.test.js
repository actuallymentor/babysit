import { describe, it, expect } from 'bun:test'

import { execute_action } from '../src/babysit/actions.js'

describe( `special babysit actions`, () => {

    it( `maps enter to the Enter key`, async () => {

        const sent = []

        await execute_action( `session`, `enter`, {}, {
            send_enter_fn: session => sent.push( [ `enter`, session ] ),
        } )

        expect( sent ).toEqual( [ [ `enter`, `session` ] ] )

    } )

} )
