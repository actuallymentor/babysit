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
        expect( output ).toMatch( /-\s+attached\s+claude\s+baby-2\s+babysit_legacy/ )
        expect( output ).not.toContain( `Open one with:` )

    } )

    it( `orders and aligns the readable fields before the tmux session`, () => {

        const output = capture_console( () => print_active_sessions_table( [
            { name: `babysit_short`, attached: false },
            { name: `babysit_much_longer_session`, attached: true },
        ], [
            { tmux_session: `babysit_short`, name: `fix`, agent: `codex`, agent_session_id: `agent-1` },
            { tmux_session: `babysit_much_longer_session`, name: `feature with a longer name`, agent: `claude`, babysit_id: `baby-2` },
        ] ) )

        const lines = output.split( `\n` )
        const header = lines.find( line => line.includes( `NAME` ) )
        const first_row = lines.find( line => line.includes( `babysit_short` ) )
        const second_row = lines.find( line => line.includes( `babysit_much_longer_session` ) )

        const column_starts = [ `NAME`, `STATUS`, `AGENT`, `ID`, `SESSION` ]
            .map( column => header.indexOf( column ) )

        expect( column_starts ).toEqual( [ ...column_starts ].sort( ( left, right ) => left - right ) )
        expect( first_row.indexOf( `fix` ) ).toBe( header.indexOf( `NAME` ) )
        expect( first_row.indexOf( `detached` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( first_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( first_row.indexOf( `agent-1` ) ).toBe( header.indexOf( `ID` ) )
        expect( first_row.indexOf( `babysit_short` ) ).toBe( header.indexOf( `SESSION` ) )
        expect( second_row.indexOf( `babysit_much_longer_session` ) ).toBe( header.indexOf( `SESSION` ) )

    } )

} )
