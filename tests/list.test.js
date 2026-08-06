import { describe, it, expect } from 'bun:test'
import { cmd_list, print_active_sessions_table } from '../src/cli/list.js'

const capture_console = async ( fn ) => {

    const original_log = console.log
    const lines = []

    console.log = ( line = `` ) => lines.push( String( line ) )

    try {
        await fn()
    } finally {
        console.log = original_log
    }

    return lines.join( `\n` )

}

describe( `print_active_sessions_table`, () => {

    it( `numbers active sessions while keeping legacy unnamed sessions readable`, async () => {

        const tmux_sessions = [
            { name: `babysit_named`, attached: false },
            { name: `babysit_legacy`, attached: true },
        ]
        const stored_sessions = [
            { tmux_session: `babysit_named`, name: `feature 1`, agent: `codex`, babysit_id: `baby-1` },
            { tmux_session: `babysit_legacy`, agent: `claude`, babysit_id: `baby-2` },
        ]

        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => stored_sessions,
        } ) )

        expect( output ).toContain( `#` )
        expect( output ).toContain( `NAME` )
        expect( output ).toContain( `feature 1` )
        expect( output ).toMatch( /2\s+-\s+attached\s+claude\s+baby-2\s+babysit_legacy/ )
        expect( output ).toContain( `Open one with: babysit open <number>` )

    } )

    it( `orders and aligns the readable fields before the tmux session`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [
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

    it( `keeps numbered selectors aligned as the row count grows`, async () => {

        const tmux_sessions = Array.from( { length: 10 }, ( _, index ) => ( {
            name: `babysit_${ index + 1 }`,
            attached: false,
        } ) )
        const stored_sessions = tmux_sessions.map( ( { name: tmux_session }, index ) => ( {
            tmux_session,
            name: `task ${ index + 1 }`,
            agent: `codex`,
            babysit_id: `baby-${ index + 1 }`,
        } ) )

        const output = await capture_console( () => print_active_sessions_table(
            tmux_sessions,
            stored_sessions,
            { numbered: true }
        ) )

        const lines = output.split( `\n` )
        const header = lines.find( line => line.includes( `NAME` ) )
        const tenth_row = lines.find( line => line.includes( `babysit_10` ) )

        expect( tenth_row.indexOf( `10` ) ).toBe( header.indexOf( `#` ) )
        expect( tenth_row.indexOf( `task 10` ) ).toBe( header.indexOf( `NAME` ) )
        expect( tenth_row.indexOf( `detached` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( tenth_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( tenth_row.indexOf( `baby-10` ) ).toBe( header.indexOf( `ID` ) )
        expect( tenth_row.indexOf( `babysit_10` ) ).toBe( header.indexOf( `SESSION` ) )

    } )

    it( `uses supplied global selectors for a filtered session table`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [
            { name: `babysit_second`, attached: false },
            { name: `babysit_fourth`, attached: false },
        ], [
            { tmux_session: `babysit_second`, name: `second` },
            { tmux_session: `babysit_fourth`, name: `fourth` },
        ], {
            numbered: true,
            numbers: [ 2, 4 ],
        } ) )

        expect( output ).toMatch( /\n  2\s+second/ )
        expect( output ).toMatch( /\n  4\s+fourth/ )

    } )

} )
