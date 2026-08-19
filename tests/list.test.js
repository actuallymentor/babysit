import { describe, it, expect } from 'bun:test'
import {
    cmd_list,
    format_session_directory,
    print_active_sessions_table,
} from '../src/cli/list.js'

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

    it( `shows compact rows and collapses unnamed session IDs into NAME`, async () => {

        const tmux_sessions = [
            { name: `babysit_named`, attached: false, agent_status: `running` },
            { name: `babysit_legacy`, attached: true, agent_status: `idle` },
            { name: `babysit_canonical`, attached: false, agent_status: `running` },
        ]
        const stored_sessions = [
            {
                tmux_session: `babysit_named`,
                name: `feature 1`,
                agent: `codex`,
                babysit_id: `baby-1`,
                modifiers: [ `yolo`, `docker` ],
                pwd: `/workspace/ping/pong`,
            },
            {
                tmux_session: `babysit_legacy`,
                agent: `claude`,
                agent_session_id: `native-2`,
                babysit_id: `baby-2`,
                pwd: `/workspace/ding/dong`,
            },
            {
                tmux_session: `babysit_canonical`,
                agent: `gemini`,
                babysit_id: `baby-3`,
                modifiers: [],
                pwd: `/workspace/solo`,
            },
        ]

        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => stored_sessions,
        } ) )

        const header = output.split( `\n` ).find( line => line.includes( `NAME` ) )

        expect( header.trim().split( /\s+/ ) ).toEqual(
            [ `#`, `NAME`, `STATUS`, `TMUX`, `AGENT`, `FLAGS`, `DIRECTORY` ]
        )
        expect( output ).toMatch( /1\s+feature 1\s+running\s+detached\s+codex\s+yolo,docker\s+ping\/pong/ )
        expect( output ).toMatch( /2\s+native-2\s+idle\s+attached\s+claude\s+-\s+ding\/dong/ )
        expect( output ).toMatch( /3\s+baby-3\s+running\s+detached\s+gemini\s+-\s+workspace\/solo/ )
        expect( output ).not.toContain( `babysit_named` )
        expect( output ).not.toContain( `babysit_legacy` )
        expect( output ).toContain( `Open one with: babysit open <number>` )

    } )

    it( `orders and aligns agent status directly after the readable name`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [
            { name: `babysit_short`, attached: false, agent_status: `running` },
            { name: `babysit_much_longer_session`, attached: true, agent_status: `idle` },
        ], [
            { tmux_session: `babysit_short`, name: `fix`, agent: `codex`, agent_session_id: `agent-1`, pwd: `/work/short` },
            { tmux_session: `babysit_much_longer_session`, name: `feature with a longer name`, agent: `claude`, babysit_id: `baby-2`, pwd: `/work/long` },
        ] ) )

        const lines = output.split( `\n` )
        const header = lines.find( line => line.includes( `NAME` ) )
        const first_row = lines.find( line => line.includes( `fix` ) )
        const second_row = lines.find( line => line.includes( `feature with a longer name` ) )

        const column_starts = [ `NAME`, `STATUS`, `TMUX`, `AGENT`, `DIRECTORY` ]
            .map( column => header.indexOf( column ) )

        expect( header ).not.toContain( `FLAGS` )
        expect( column_starts ).toEqual( [ ...column_starts ].sort( ( left, right ) => left - right ) )
        expect( first_row.indexOf( `fix` ) ).toBe( header.indexOf( `NAME` ) )
        expect( first_row.indexOf( `running` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( first_row.indexOf( `detached` ) ).toBe( header.indexOf( `TMUX` ) )
        expect( first_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( first_row.indexOf( `work/short` ) ).toBe( header.indexOf( `DIRECTORY` ) )
        expect( second_row.indexOf( `idle` ) ).toBe( header.indexOf( `STATUS` ) )

    } )

    it( `keeps numbered selectors aligned as the row count grows`, async () => {

        const tmux_sessions = Array.from( { length: 10 }, ( _, index ) => ( {
            name: `babysit_${ index + 1 }`,
            attached: false,
            agent_status: `running`,
        } ) )
        const stored_sessions = tmux_sessions.map( ( { name: tmux_session }, index ) => ( {
            tmux_session,
            name: `task ${ index + 1 }`,
            agent: `codex`,
            babysit_id: `baby-${ index + 1 }`,
            pwd: `/workspace/task-${ index + 1 }`,
        } ) )

        const output = await capture_console( () => print_active_sessions_table(
            tmux_sessions,
            stored_sessions,
            { numbered: true }
        ) )

        const lines = output.split( `\n` )
        const header = lines.find( line => line.includes( `NAME` ) )
        const tenth_row = lines.find( line => line.includes( `task 10` ) )

        expect( tenth_row.indexOf( `10` ) ).toBe( header.indexOf( `#` ) )
        expect( tenth_row.indexOf( `task 10` ) ).toBe( header.indexOf( `NAME` ) )
        expect( tenth_row.indexOf( `running` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( tenth_row.indexOf( `detached` ) ).toBe( header.indexOf( `TMUX` ) )
        expect( tenth_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( tenth_row.indexOf( `workspace/task-10` ) ).toBe( header.indexOf( `DIRECTORY` ) )

    } )

    it( `adds IDs and full tmux session names with --all`, async () => {

        const output = await capture_console( () => cmd_list( {
            flags: { all: true },
            list_sessions_fn: async () => [ {
                name: `babysit_/ping/pong/ding/dong_codex_123`,
                attached: false,
                agent_status: `idle`,
            } ],
            list_stored_sessions_fn: () => [ {
                tmux_session: `babysit_/ping/pong/ding/dong_codex_123`,
                name: `feature`,
                agent: `codex`,
                agent_session_id: `native-1`,
                modifiers: [ `sandbox`, `docker` ],
                pwd: `/ping/pong/ding/dong`,
            } ],
        } ) )

        const header = output.split( `\n` ).find( line => line.includes( `NAME` ) )

        expect( header.trim().split( /\s+/ ) ).toEqual(
            [ `#`, `NAME`, `STATUS`, `TMUX`, `AGENT`, `FLAGS`, `DIRECTORY`, `ID`, `SESSION` ]
        )
        expect( output ).toContain( `sandbox,docker` )
        expect( output ).toContain( `native-1` )
        expect( output ).toContain( `babysit_/ping/pong/ding/dong_codex_123` )

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

    it( `falls back to the raw tmux ID when stored metadata is unavailable`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [ {
            name: `babysit_/workspace/legacy_codex_123`,
            attached: false,
        } ], [] ) )

        expect( output ).toMatch( /babysit_\/workspace\/legacy_codex_123\s+running\s+detached\s+unknown\s+-/ )

    } )

} )

describe( `format_session_directory`, () => {

    it( `keeps the deepest two directory levels`, () => {
        expect( format_session_directory( `/ping/pong/ding/dong` ) ).toBe( `ding/dong` )
        expect( format_session_directory( `/ping/pong/ding/dong/` ) ).toBe( `ding/dong` )
        expect( format_session_directory( `/one level/two levels` ) ).toBe( `one level/two levels` )
    } )

    it( `keeps short and missing paths readable`, () => {
        expect( format_session_directory( `/workspace` ) ).toBe( `workspace` )
        expect( format_session_directory( `/` ) ).toBe( `/` )
        expect( format_session_directory() ).toBe( `-` )
    } )

} )
