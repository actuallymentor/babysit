import { describe, it, expect } from 'bun:test'
import {
    cmd_list,
    observe_session_activity,
    format_session_directory,
    format_session_status_label,
    format_session_tree,
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

    it( `shows waiting without changing attachment or session identity`, async () => {
        const output = await capture_console( () => print_active_sessions_table(
            [ { name: `babysit_background`, attached: false, agent_status: `waiting` } ],
            [ { tmux_session: `babysit_background`, agent: `claude`, name: `background tasks` } ]
        ) )

        expect( output ).toMatch( /background tasks\s+waiting\s+detached\s+claude/ )
    } )

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
                container_id: `a`.repeat( 12 ),
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
                agent: `antigravity`,
                babysit_id: `baby-3`,
                modifiers: [],
                pwd: `/workspace/solo`,
            },
        ]

        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => stored_sessions,
            observe_activity_fn: async sessions => sessions,
            // One full-id match, one matched by the babysit-<id> container name, one absent
            container_stats_fn: async () => [
                { id: `${ `a`.repeat( 64 ) }`, name: `babysit-baby-1`, cpu: `12.50%`, memory: `240.1MiB` },
                { id: `${ `b`.repeat( 64 ) }`, name: `babysit-baby-2`, cpu: `0.00%`, memory: `1.5GiB` },
            ],
        } ) )

        const header = output.split( `\n` ).find( line => line.includes( `NAME` ) )

        expect( header.trim().split( /\s+/ ) ).toEqual(
            [ `#`, `NAME`, `STATUS`, `TMUX`, `AGENT`, `CPU`, `MEM`, `FLAGS` ]
        )
        // Directories are trunks; numbered leaves hang below them
        expect( output ).toMatch( /\n {2}ping\/pong\n {2}└─ 1\s+feature 1\s+running\s+detached\s+codex\s+12\.50%\s+240\.1MiB\s+yolo,docker\n/ )
        expect( output ).toMatch( /\n {2}ding\/dong\n {2}└─ 2\s+native-2\s+idle\s+attached\s+claude\s+0\.00%\s+1\.5GiB\s+-\n/ )
        expect( output ).toMatch( /\n {2}workspace\/solo\n {2}└─ 3\s+baby-3\s+running\s+detached\s+antigravity\s+-\s+-\s+-\n/ )
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

        const column_starts = [ `NAME`, `STATUS`, `TMUX`, `AGENT` ]
            .map( column => header.indexOf( column ) )

        expect( header ).not.toContain( `FLAGS` )
        expect( header ).not.toContain( `DIRECTORY` )
        expect( column_starts ).toEqual( [ ...column_starts ].sort( ( left, right ) => left - right ) )
        expect( first_row.indexOf( `fix` ) ).toBe( header.indexOf( `NAME` ) )
        expect( first_row.indexOf( `running` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( first_row.indexOf( `detached` ) ).toBe( header.indexOf( `TMUX` ) )
        expect( first_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( lines ).toContain( `  work/short` )
        expect( lines ).toContain( `  work/long` )
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
        expect( lines.indexOf( `  workspace/task-10` ) ).toBe( lines.indexOf( tenth_row ) - 1 )

    } )

    it( `adds IDs and full tmux session names with --all`, async () => {

        const output = await capture_console( () => cmd_list( {
            flags: { all: true },
            observe_activity_fn: async sessions => sessions,
            container_stats_fn: async () => [],
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
            [ `#`, `NAME`, `STATUS`, `TMUX`, `AGENT`, `CPU`, `MEM`, `FLAGS`, `ID`, `SESSION` ]
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

        expect( output ).toMatch( /\n {2}├─ 2\s+second/ )
        expect( output ).toMatch( /\n {2}└─ 4\s+fourth/ )

    } )

    it( `falls back to the raw tmux ID when stored metadata is unavailable`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [ {
            name: `babysit_/workspace/legacy_codex_123`,
            attached: false,
        } ], [] ) )

        expect( output ).toMatch( /\n {2}-\n {2}└─ babysit_\/workspace\/legacy_codex_123\s+unknown\s+detached\s+unknown\n/ )

    } )

    it( `groups sessions under their workspace trunk in first-seen order`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [
            { name: `babysit_a`, attached: false, agent_status: `running` },
            { name: `babysit_b`, attached: false, agent_status: `idle` },
            { name: `babysit_c`, attached: false, agent_status: `waiting` },
        ], [
            { tmux_session: `babysit_a`, name: `one`, agent: `codex`, pwd: `/w/ping/pong` },
            { tmux_session: `babysit_b`, name: `two`, agent: `claude`, pwd: `/w/ding/dong` },
            { tmux_session: `babysit_c`, name: `three`, agent: `claude`, pwd: `/w/ping/pong` },
        ], { numbered: true } ) )

        const lines = output.split( `\n` ).filter( line => line.startsWith( `  ` ) ).slice( 2 )

        expect( lines.map( line => line.trim().split( /\s+/ ).slice( 0, 3 ).join( ` ` ) ) ).toEqual( [
            `ping/pong`,
            `├─ 1 one`,
            `└─ 3 three`,
            `ding/dong`,
            `└─ 2 two`,
        ] )

    } )

    it( `separates workspace trunks with a blank line`, () => {

        const tree = format_session_tree( [ `#`, `NAME` ], [ [ `1`, `one` ], [ `2`, `two` ], [ `3`, `three` ] ], [ `repo`, `other`, `repo` ], { env: { TERM: `dumb` } } )

        expect( tree.lines ).toEqual( [ `repo`, `|- 1  one`, `\\- 3  three`, ``, `other`, `\\- 2  two` ] )

    } )

    it( `keeps distinct workspaces apart when their compact directories collide`, async () => {

        const output = await capture_console( () => print_active_sessions_table( [
            { name: `babysit_prod`, attached: false, agent_status: `idle` },
            { name: `babysit_stage`, attached: false, agent_status: `idle` },
            { name: `babysit_prod2`, attached: false, agent_status: `idle` },
        ], [
            { tmux_session: `babysit_prod`, name: `p1`, agent: `codex`, pwd: `/production/team/app` },
            { tmux_session: `babysit_stage`, name: `s1`, agent: `codex`, pwd: `/staging/team/app` },
            { tmux_session: `babysit_prod2`, name: `p2`, agent: `codex`, pwd: `/production/team/app` },
        ], { numbered: true } ) )

        const lines = output.split( `\n` ).filter( line => line.startsWith( `  ` ) ).slice( 2 )

        expect( lines.map( line => line.trim().split( /\s+/ ).slice( 0, 3 ).join( ` ` ) ) ).toEqual( [
            `/production/team/app`,
            `├─ 1 p1`,
            `└─ 3 p2`,
            `/staging/team/app`,
            `└─ 2 s1`,
        ] )

    } )

    it( `renders ASCII branches on dumb terminals`, () => {

        const tree = format_session_tree( [ `#`, `NAME` ], [ [ 1, `one` ], [ 2, `two` ] ], [ `repo`, `repo` ], {
            env: { TERM: `dumb` },
        } )

        expect( tree.lines ).toEqual( [ `repo`, `|- 1  one`, `\\- 2  two` ] )
        expect( tree.header ).toBe( `   #  NAME` )
        expect( tree.divider.length ).toBe( Math.max( tree.header.length, ...tree.lines.map( line => line.length ) ) )

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

describe( `format_session_status_label`, () => {

    it( `shows the name, compact original directory, and active flags`, () => {
        expect( format_session_status_label( {
            name: `Check out settings`,
            pwd: `/home/mentor/dev/benchmark-server-PRIVATE`,
            modifiers: [ `yolo`, `docker`, `clone` ],
        } ) ).toBe( `Check out settings · dev/benchmark-server-PRIVATE · [yolo, docker, clone]` )
    } )

    it( `omits unavailable names and empty flag groups`, () => {
        expect( format_session_status_label( {
            pwd: `/workspace/project`,
            modifiers: [],
        } ) ).toBe( `workspace/project` )
    } )

    it( `filters name modifiers and neutralizes unsafe status text`, () => {
        expect( format_session_status_label( {
            name: `unsafe\nname#[fg=red]`,
            pwd: `/work\tspace/project`,
            modifiers: [ `name`, `yolo\u007fmode` ],
        } ) ).toBe( `unsafe?name?[fg=red] · work?space/project · [yolo?mode]` )
    } )

} )

describe( `observe_session_activity`, () => {

    it( `replaces stale and missing monitor options using fresh exact pane captures`, async () => {
        const sessions = [
            { name: `babysit_idle`, agent_status: `running` },
            { name: `babysit_busy`, agent_status: `idle` },
            { name: `babysit_legacy` },
        ]
        let second_sample = false
        const targets = []
        const observed = await observe_session_activity( sessions, [], {
            capture: async target => {
                targets.push( target )
                return target === `=babysit_busy:` && second_sample ? `new output` : `first output`
            },
            wait: async milliseconds => {
                expect( milliseconds ).toBe( 1_000 )
                expect( targets ).toHaveLength( 3 )
                second_sample = true
            },
        } )

        expect( observed.map( session => session.agent_status ) ).toEqual( [ `idle`, `running`, `idle` ] )
        expect( targets ).toEqual( [ ...sessions, ...sessions ].map( session => `=${ session.name }:` ) )
        expect( sessions[0].agent_status ).toBe( `running` )
    } )

    it( `reports unknown when either capture fails without hiding other sessions`, async () => {
        let second_sample = false
        const sessions = [ `first_failure`, `second_failure`, `healthy` ].map( name => ( { name, agent_status: `running` } ) )
        const observed = await observe_session_activity( sessions, [], {
            capture: async target => {
                if( target === `=first_failure:` && !second_sample || target === `=second_failure:` && second_sample ) {
                    throw new Error( `pane unavailable` )
                }
                return `stable`
            },
            wait: async () => {
                second_sample = true
            },
        } )

        expect( observed.map( session => session.agent_status ) ).toEqual( [ `unknown`, `unknown`, `idle` ] )
    } )

    it( `prints newly observed status rather than the cached list value`, async () => {
        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => [ { name: `babysit_stale`, attached: false, agent_status: `running` } ],
            list_stored_sessions_fn: () => [],
            container_stats_fn: async () => [],
            observe_activity_fn: ( sessions, stored ) => observe_session_activity( sessions, stored, {
                capture: async () => `waiting for input`,
                wait: async () => {},
            } ),
        } ) )

        expect( output ).toMatch( /babysit_stale\s+idle\s+detached/ )
    } )

} )
