import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { show_help } from '../src/cli/help.js'

describe( `CLI help`, () => {

    let lines
    let original_log

    beforeEach( () => {
        lines = []
        original_log = console.log
        console.log = ( line = `` ) => lines.push( String( line ) )
    } )

    afterEach( () => {
        console.log = original_log
    } )

    it( `documents doctor selection, real auth checks, and cache refresh`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit doctor --auth [agent|all]` )
        expect( help ).toContain( `make real model-backed auth checks` )
        expect( help ).toContain( `bypass the 12-hour success cache` )
        expect( help ).toContain( `babysit doctor --auth opencode --refresh` )

    } )

} )
