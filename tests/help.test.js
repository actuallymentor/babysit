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

    it( `documents workspace-aware resume history and its --all escape hatch`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `List this workspace's sessions or resume one` )
        expect( help ).toContain( `with "resume", show every workspace` )
        expect( help ).toContain( `babysit resume --all` )

    } )

    it( `documents clone pruning and its noninteractive inventory`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit prune [--list]` )
        expect( help ).toContain( `Remove unused clone workspaces` )
        expect( help ).toContain( `list clone workspaces and directory sizes` )

    } )

} )
