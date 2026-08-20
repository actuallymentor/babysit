import { describe, expect, it } from 'bun:test'

import { time_phase, time_phase_sync } from '../src/utils/timing.js'

describe( `phase timing`, () => {

    it( `stays silent unless explicitly enabled`, async () => {

        const messages = []
        const value = await time_phase( `startup`, async () => `ok`, {
            env: {},
            debug: message => messages.push( message ),
        } )

        expect( value ).toBe( `ok` )
        expect( messages ).toEqual( [] )

    } )

    it( `reports async duration even when the phase throws`, async () => {

        const messages = []
        const times = [ 1_000, 1_275 ]

        await expect( time_phase( `authentication`, async () => {
            throw new Error( `probe failed` )
        }, {
            env: { BABYSIT_DEBUG: `1` },
            now: () => times.shift(),
            debug: message => messages.push( message ),
        } ) ).rejects.toThrow( `probe failed` )

        expect( messages ).toEqual( [ `Timing authentication: 275ms` ] )

    } )

    it( `reports synchronous duration and preserves the result`, () => {

        const messages = []
        const times = [ 2_000, 2_042 ]
        const value = time_phase_sync( `dependencies`, () => 7, {
            env: { BABYSIT_DEBUG: `1` },
            now: () => times.shift(),
            debug: message => messages.push( message ),
        } )

        expect( value ).toBe( 7 )
        expect( messages ).toEqual( [ `Timing dependencies: 42ms` ] )

    } )

} )
