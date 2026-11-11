import { describe, it, expect } from 'bun:test'
import { post_attach_hint, take_exit_notice } from '../src/cli/exit_notice.js'

describe( `post_attach_hint`, () => {

    it( `prints on its own lines when no watch follows`, () => {
        const printed = []
        post_attach_hint( `Resume with: babysit resume x`, { follows: false, print: text => printed.push( text ) } )
        expect( printed ).toEqual( [ `\nResume with: babysit resume x\n` ] )
        expect( take_exit_notice() ).toBeNull()
    } )

    it( `holds the text for the watch, once, when one follows`, () => {
        const printed = []
        post_attach_hint( `Detached. Re-attach with: babysit open x`, { follows: true, print: text => printed.push( text ) } )
        expect( printed ).toEqual( [] )
        expect( take_exit_notice() ).toBe( `Detached. Re-attach with: babysit open x` )
        expect( take_exit_notice() ).toBeNull()
    } )

} )
