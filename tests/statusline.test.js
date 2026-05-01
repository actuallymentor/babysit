import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { write_loop_deadline, LOOP_DEADLINE_CONTAINER_PATH, LOOP_DEADLINE_PATH } from '../src/statusline/render.js'

describe( `write_loop_deadline`, () => {

    it( `exports host and container deadline path constants`, () => {
        expect( LOOP_DEADLINE_PATH ).toBe( join( homedir(), `.babysit`, `loop-deadline` ) )
        expect( LOOP_DEADLINE_CONTAINER_PATH ).toBe( `/tmp/babysit-loop-deadline` )
    } )

    it( `writes a number to the deadline file`, () => {
        expect( write_loop_deadline( 1234567890 ) ).toBe( true )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `1234567890` )
    } )

    it( `writes "idle" sentinel to the deadline file`, () => {
        expect( write_loop_deadline( `idle` ) ).toBe( true )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `idle` )
    } )

} )
