import { describe, it, expect } from 'bun:test'
import { print_active_sessions_table } from '../src/cli/list.js'

const capture_console = ( fn ) => {

    const original_log = console.log
    const lines = []

    console.log = ( line = `` ) => lines.push( String( line ) )

    try {
        fn()
    } finally {
        console.log = original_log
    }

    return lines.join( `\n` )

}

describe( `print_active_sessions_table`, () => {

    it( `shows names while keeping legacy unnamed sessions readable`, () => {

        const output = capture_console( () => print_active_sessions_table( [
            { name: `babysit_named`, attached: false },
            { name: `babysit_legacy`, attached: true },
        ], [
            { tmux_session: `babysit_named`, name: `feature 1`, agent: `codex`, babysit_id: `baby-1` },
            { tmux_session: `babysit_legacy`, agent: `claude`, babysit_id: `baby-2` },
        ] ) )

        expect( output ).toContain( `NAME` )
        expect( output ).toContain( `feature 1` )
        expect( output ).toMatch( /babysit_legacy\s+-\s+claude/ )
        expect( output ).not.toContain( `Open one with:` )

    } )

} )
