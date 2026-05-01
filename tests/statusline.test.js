import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'

import { write_loop_deadline, LOOP_DEADLINE_PATH } from '../src/statusline/render.js'

describe( `write_loop_deadline`, () => {

    it( `exports the deadline path constant`, () => {
        expect( LOOP_DEADLINE_PATH ).toBe( `/tmp/babysit-loop-deadline` )
    } )

    it( `writes a number to the deadline file`, () => {
        write_loop_deadline( 1234567890 )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `1234567890` )
    } )

    it( `writes "idle" sentinel to the deadline file`, () => {
        write_loop_deadline( `idle` )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `idle` )
    } )

} )
