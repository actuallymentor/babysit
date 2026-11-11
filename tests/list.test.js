import { describe, it, expect } from 'bun:test'
import {
    cmd_list,
    observe_session_activity,
    format_session_directory,
    format_session_status_label,
    format_session_tree,
    print_active_sessions_table,
    session_dot,
    format_countdown,
    format_last_opened,
    render_active_sessions,
    clean_pane_title,
    order_active_sessions,
    is_idle_session,
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

        expect( output ).toMatch( /background tasks\s+waiting\s+claude/ )
    } )

    it( `dots unread and day-old idle sessions, keeping names aligned`, async () => {
        const now = 1_800_000_000_000
        const day_ago = now / 1_000 - 25 * 3_600
        const output = await capture_console( () => print_active_sessions_table(
            [
                { name: `babysit_done`, attached: false, agent_status: `idle`, unread: true, idle_since: day_ago },
                { name: `babysit_old`, attached: false, agent_status: `idle`, idle_since: day_ago },
                { name: `babysit_fresh`, attached: false, agent_status: `idle`, idle_since: now / 1_000 - 60 },
                // A leftover stamp never outranks fresh activity
                { name: `babysit_again`, attached: false, agent_status: `running`, unread: true, idle_since: day_ago },
            ],
            [
                { tmux_session: `babysit_done`, agent: `claude`, name: `done` },
                { tmux_session: `babysit_old`, agent: `claude`, name: `old` },
                { tmux_session: `babysit_fresh`, agent: `claude`, name: `fresh` },
                { tmux_session: `babysit_again`, agent: `codex`, name: `again` },
            ],
            { now }
        ) )

        expect( output ).toMatch( /├─ ● done\s+idle\s+claude/ )
        expect( output ).toMatch( /├─ ● old\s+idle/ )
        expect( output ).toMatch( /├─ {3}fresh\s+idle/ )
        expect( output ).toMatch( /└─ {3}again\s+running\s+codex/ )
        const lines = output.split( `\n` )
        expect( lines.find( line => line.includes( `done` ) ).indexOf( `done` ) ).toBe( lines.find( line => line.includes( `NAME` ) ).indexOf( `NAME` ) )
    } )

    it( `counts down to an idle rule's next turn and hides rule flags on request`, async () => {
        const now = 1_800_000_000_000
        const output = await capture_console( () => print_active_sessions_table(
            [
                { name: `babysit_loop`, attached: false, agent_status: `idle`, next_turn: now / 1_000 + 2 * 3_600 + 5 * 60 + 30 },
                { name: `babysit_busy`, attached: false, agent_status: `running`, next_turn: now / 1_000 + 60 },
                { name: `babysit_plain`, attached: false, agent_status: `idle` },
            ],
            [
                { tmux_session: `babysit_loop`, agent: `claude`, name: `loop`, modifiers: [ `yolo` ], config_flags: [ `config:api.yaml`, `on:idle/30m` ] },
                { tmux_session: `babysit_busy`, agent: `claude`, name: `busy` },
                { tmux_session: `babysit_plain`, agent: `claude`, name: `plain`, config_flags: [ `on:idle/30m` ] },
            ],
            { now, countdowns: true, rule_flags: false, show_flags: true }
        ) )

        expect( output ).toMatch( /loop\s+02:05\s+claude\s+yolo\n/ )
        expect( output ).toMatch( /busy\s+running/ )
        expect( output ).toMatch( /plain\s+idle\s+claude\s+-\n/ )
        expect( output ).not.toContain( `on:idle` )
        expect( format_countdown( now / 1_000 - 5, now ) ).toBe( `00:00` )
    } )

    it( `paints the unread dot blue and the stale dot grey`, () => {
        const now = 1_800_000_000_000
        expect( session_dot( { unread: true, idle_since: 1 }, `idle`, now ) ).toBe( `unread` )
        expect( session_dot( { idle_since: now / 1_000 - 25 * 3_600 }, `idle`, now ) ).toBe( `stale` )
        expect( session_dot( { idle_since: now / 1_000 - 23 * 3_600 }, `idle`, now ) ).toBe( null )
        expect( session_dot( { idle_since: null }, `idle`, now ) ).toBe( null )
        expect( session_dot( { unread: true, idle_since: 1 }, `waiting`, now ) ).toBe( null )
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
                usage: { cpu_percent: 12.5, memory_bytes: 240 * 1024 ** 2, sampled_at: new Date().toISOString() },
                modifiers: [ `yolo`, `docker` ],
                pwd: `/workspace/ping/pong`,
            },
            {
                tmux_session: `babysit_legacy`,
                agent: `claude`,
                agent_session_id: `native-2`,
                babysit_id: `baby-2`,
                usage: { cpu_percent: 50, memory_bytes: 1024 ** 3, sampled_at: new Date( Date.now() - 60 * 60_000 ).toISOString() },
                pwd: `/workspace/ding/dong`,
            },
            {
                tmux_session: `babysit_canonical`,
                agent: `antigravity`, // retired agents still list
                babysit_id: `baby-3`,
                modifiers: [],
                config_flags: [ `on:idle/30m` ],
                pwd: `/workspace/solo`,
            },
        ]

        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => stored_sessions,
            observe_activity_fn: async sessions => sessions,
        } ) )

        const header = output.split( `\n` ).find( line => line.includes( `NAME` ) )

        expect( header.trim().split( /\s+/ ) ).toEqual(
            [ `#`, `NAME`, `STATUS`, `AGENT`, `CPU`, `MEM`, `FLAGS` ]
        )
        // Directories are trunks; numbered leaves hang below them. Usage comes
        // from the monitor's cache: fresh, stale (ignored), and absent.
        expect( output ).toMatch( /\n {2}ping\/pong\n {2}└─ 1\s+feature 1\s+running\s+codex\s+12\.5%\s+240 MiB\s+yolo,docker\n/ )
        expect( output ).toMatch( /\n {2}ding\/dong\n {2}└─ 2\s+native-2\s+idle\s+claude\s+-\s+-\s+-\n/ )
        expect( output ).toMatch( /\n {2}workspace\/solo\n {2}└─ 3\s+baby-3\s+running\s+antigravity\s+-\s+-\s+on:idle\/30m\n/ )
        // Totals sit under the CPU/MEM columns and ignore stale samples
        expect( output ).toMatch( /\n\s+Total\s+12\.5%\s+240 MiB\n/ )
        expect( output ).not.toContain( `detached` )
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

        const column_starts = [ `NAME`, `STATUS`, `AGENT` ]
            .map( column => header.indexOf( column ) )

        expect( header ).not.toContain( `FLAGS` )
        expect( header ).not.toContain( `DIRECTORY` )
        expect( column_starts ).toEqual( [ ...column_starts ].sort( ( left, right ) => left - right ) )
        expect( first_row.indexOf( `fix` ) ).toBe( header.indexOf( `NAME` ) )
        expect( first_row.indexOf( `running` ) ).toBe( header.indexOf( `STATUS` ) )
        expect( header ).not.toContain( `TMUX` )
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
        expect( tenth_row.indexOf( `codex` ) ).toBe( header.indexOf( `AGENT` ) )
        expect( lines.indexOf( `  workspace/task-10` ) ).toBe( lines.indexOf( tenth_row ) - 1 )

    } )

    it( `adds IDs and full tmux session names with --all`, async () => {

        const output = await capture_console( () => cmd_list( {
            version_check_fn: () => ( { latest: null, refresh: null } ),
            flags: { all: true },
            observe_activity_fn: async sessions => sessions,
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
            [ `#`, `NAME`, `STATUS`, `AGENT`, `CPU`, `MEM`, `FLAGS`, `TMUX`, `ID`, `SESSION` ]
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

        expect( output ).toMatch( /\n {2}-\n {2}└─ {3}babysit_\/workspace\/legacy_codex_123\s+unknown\s+unknown\n/ )

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
            version_check_fn: () => ( { latest: null, refresh: null } ),
            list_sessions_fn: async () => [ { name: `babysit_stale`, attached: false, agent_status: `running` } ],
            list_stored_sessions_fn: () => [],
            observe_activity_fn: ( sessions, stored ) => observe_session_activity( sessions, stored, {
                capture: async () => `waiting for input`,
                wait: async () => {},
            } ),
        } ) )

        expect( output ).toMatch( /babysit_stale\s+idle\s+unknown/ )
    } )

} )

describe( `list colors`, () => {

    const colored = async render => {
        const previous = process.env.FORCE_COLOR
        process.env.FORCE_COLOR = `1`
        try {
            return await capture_console( render )
        } finally {
            if( previous === undefined ) delete process.env.FORCE_COLOR
            else process.env.FORCE_COLOR = previous
        }
    }

    it( `paints status by activity and totals by share of host capacity`, async () => {

        const sampled_at = new Date().toISOString()
        const output = await colored( () => print_active_sessions_table( [
            { name: `babysit_a`, attached: false, agent_status: `idle` },
            { name: `babysit_b`, attached: false, agent_status: `running` },
            { name: `babysit_c`, attached: false, agent_status: `waiting` },
        ], [
            { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w`, usage: { cpu_percent: 150, memory_bytes: 8 * 1024 ** 3, sampled_at, host_cpus: 4, host_memory_bytes: 16 * 1024 ** 3 } },
            { tmux_session: `babysit_b`, name: `b`, agent: `codex`, babysit_id: `b`, pwd: `/w`, usage: { cpu_percent: 150, memory_bytes: 1024 ** 3, sampled_at, host_cpus: 4, host_memory_bytes: 16 * 1024 ** 3 } },
            { tmux_session: `babysit_c`, name: `c`, agent: `codex`, babysit_id: `c`, pwd: `/w` },
        ], { show_usage: true } ) )

        expect( output ).toContain( `\x1b[38;5;245midle` )
        expect( output ).toContain( `\x1b[32mrunning` )
        expect( output ).toContain( `\x1b[38;5;208mwaiting` )
        // Each 150% of four cores is 37.5% of the host; 75% total is red; 9 GiB of 16 GiB is yellow
        expect( output ).toContain( `37.5%` )
        expect( output ).toContain( `\x1b[31m75.0%` )
        expect( output ).toContain( `\x1b[33m9216 MiB` )

    } )

    it( `shows a stuck flag in red over the observed status`, async () => {
        const output = await colored( () => print_active_sessions_table(
            [ { name: `babysit_a`, attached: false, agent_status: `running` } ],
            [ { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w`, stuck_at: `2026-10-06T12:00:00.000Z` } ]
        ) )
        expect( output ).toContain( `\x1b[31mstuck` )
        expect( output ).not.toContain( `running` )
    } )

    it( `stays plain without a color-capable terminal`, async () => {
        const output = await capture_console( () => print_active_sessions_table(
            [ { name: `babysit_a`, attached: false, agent_status: `running` } ],
            [ { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w` } ]
        ) )
        expect( output ).not.toContain( `\x1b[` )
    } )

} )

describe( `list version notice`, () => {

    it( `prints an orange notice under the table when a newer release is cached`, async () => {
        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => [ { name: `babysit_a`, attached: false, agent_status: `idle` } ],
            list_stored_sessions_fn: () => [ { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w` } ],
            observe_activity_fn: async sessions => sessions,
            version_check_fn: () => ( { latest: `9.9.9`, refresh: null } ),
        } ) )
        expect( output ).toContain( `New babysit version available: 9.9.9 (run babysit update)` )
    } )

    it( `stays quiet when up to date`, async () => {
        const output = await capture_console( () => cmd_list( {
            list_sessions_fn: async () => [ { name: `babysit_a`, attached: false, agent_status: `idle` } ],
            list_stored_sessions_fn: () => [ { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w` } ],
            observe_activity_fn: async sessions => sessions,
            version_check_fn: () => ( { latest: null, refresh: null } ),
        } ) )
        expect( output ).not.toContain( `New babysit version` )
    } )

} )

describe( `list --watch`, () => {

    it( `is retired in favor of babysit watch`, async () => {
        const original_error = console.error
        const errors = []
        console.error = line => errors.push( line )
        try {
            await cmd_list( { flags: { watch: true }, list_sessions_fn: async () => {
                throw new Error( `listed` ) 
            } } )
        } finally {
            console.error = original_error
        }
        expect( errors ).toEqual( [ `babysit list --watch is gone; run babysit watch` ] )
        expect( process.exitCode ).toBe( 1 )
        process.exitCode = 0
    } )

} )

describe( `format_last_opened`, () => {

    it( `reads days and hours ago`, () => {
        const now = 1_000_000_000_000
        expect( format_last_opened( now / 1_000 - ( 2 * 24 + 5 ) * 3_600 - 60, now ) ).toBe( `2d 5h` )
        expect( format_last_opened( now / 1_000 - 3_600, now ) ).toBe( `0d 1h` )
        expect( format_last_opened( null, now ) ).toBe( `-` )
    } )

} )

describe( `render_active_sessions recent_first + idle_section`, () => {

    const now = Date.now()
    const hours_ago = hours => Math.floor( now / 1_000 ) - hours * 3_600
    const stored = [
        { tmux_session: `babysit_old`, name: `old`, agent: `codex`, babysit_id: `old`, pwd: `/dev/stale-repo` },
        { tmux_session: `babysit_new`, name: `new`, agent: `codex`, babysit_id: `new`, pwd: `/dev/fresh` },
        { tmux_session: `babysit_mid`, name: `mid`, agent: `codex`, babysit_id: `mid`, pwd: `/dev/other` },
        { tmux_session: `babysit_unread`, name: `unread`, agent: `codex`, babysit_id: `unread`, pwd: `/dev/other` },
    ]
    const sessions = [
        { name: `babysit_old`, agent_status: `idle`, idle_since: hours_ago( 53 ), last_opened: hours_ago( 53 ) },
        { name: `babysit_mid`, agent_status: `running`, last_opened: hours_ago( 5 ) },
        { name: `babysit_new`, agent_status: `running`, last_opened: hours_ago( 1 ) },
        { name: `babysit_unread`, agent_status: `idle`, idle_since: hours_ago( 60 ), last_opened: hours_ago( 70 ), unread: true },
    ]
    const render = () => {
        let result
        return capture_console( async () => {
            result = await render_active_sessions( {
                recent_first: true,
                idle_section: true,
                open_hint: false,
                version_check_fn: () => ( { latest: null } ),
                list_sessions_fn: async () => sessions,
                list_stored_sessions_fn: () => stored,
                observe_activity_fn: async list => list,
            } )
        } ).then( output => ( { output, result } ) )
    }

    it( `numbers by recency, workspaces led by their newest session`, async () => {
        const { result } = await render()
        expect( result.rows.map( row => row.target ) ).toEqual( [ `new`, `mid`, `old`, `unread` ] )
        expect( result.rows.map( row => row.number ) ).toEqual( [ 1, 2, 3, 4 ] )
    } )

    it( `moves sessions idle over 24h into a condensed list, unread ones keep their dot`, async () => {
        const { output } = await render()
        const [ tree, idle ] = output.split( `Idle resumable sessions:` )
        expect( tree ).not.toContain( `stale-repo` )
        expect( tree ).not.toContain( `unread` )
        expect( idle ).toMatch( /3\s+dev\/stale-repo - old\s+- 2d 5h/ )
        expect( idle ).toMatch( /4\s+● dev\/other\s+- unread\s+- 2d 22h/ )
    } )

    it( `ranks by last opened only: a never-opened session sinks`, async () => {
        sessions.push( { name: `babysit_loop`, agent_status: `running` } )
        stored.push( { tmux_session: `babysit_loop`, name: `loop`, agent: `codex`, babysit_id: `loop`, pwd: `/dev/loop` } )
        const { result } = await render()
        sessions.pop()
        stored.pop()
        expect( result.rows.map( row => row.target ).slice( 0, 2 ) ).toEqual( [ `new`, `mid` ] )
        expect( result.rows.findIndex( row => row.target === `loop` ) ).toBe( 2 )
    } )

    it( `moves a session shelved since its last turn into the idle list, until the next turn ends`, async () => {
        sessions[2] = { ...sessions[2], agent_status: `idle`, idle_since: hours_ago( 2 ), shelved_since: hours_ago( 1 ) }
        expect( ( await render() ).output.split( `Idle resumable sessions:` )[1] ).toContain( ` new ` )
        sessions[2] = { ...sessions[2], idle_since: hours_ago( 0 ) }
        expect( ( await render() ).output.split( `Idle resumable sessions:` )[1] ).not.toContain( ` new ` )
        sessions[2] = { name: `babysit_new`, agent_status: `running`, last_opened: hours_ago( 1 ) }
    } )

    it( `reports the printed line of every row`, async () => {
        const { output, result } = await render()
        const lines = output.split( `\n` )
        result.rows.forEach( row => expect( lines[ row.line ] ).toContain( ` ${ row.target }` ) )
    } )

} )

describe( `clean_pane_title`, () => {

    it( `strips the spinner glyph and Codex's directory suffix`, () => {
        expect( clean_pane_title( `✳ Background shell sleep test` ) ).toBe( `Background shell sleep test` )
        expect( clean_pane_title( `⠧ Start background sleep | tmp` ) ).toBe( `Start background sleep` )
        expect( clean_pane_title( `Run: fix a | b | tmp` ) ).toBe( `Run: fix a | b` )
    } )

    it( `reads placeholders and bare directory names as no title yet`, () => {
        const context = { pwd: `/home/me/dev/tmp`, tmux_name: `babysit_x` }
        expect( clean_pane_title( `5bbed5939b55`, context ) ).toBeNull()
        expect( clean_pane_title( `runnervmwuk1x`, { ...context, host: `runnervmwuk1x` } ) ).toBeNull()
        expect( clean_pane_title( `build-box`, { ...context, host: `build-box.local` } ) ).toBeNull()
        expect( clean_pane_title( `⠧ tmp`, context ) ).toBeNull()
        expect( clean_pane_title( `Claude Code`, context ) ).toBeNull()
        expect( clean_pane_title( ``, context ) ).toBeNull()
        expect( clean_pane_title( null, context ) ).toBeNull()
    } )

} )

describe( `render_active_sessions titles`, () => {

    const render = async ( stored_title, pane_title ) => {
        let result
        await capture_console( async () => {
            result = await render_active_sessions( {
                version_check_fn: () => ( { latest: null } ),
                list_sessions_fn: async () => [ { name: `babysit_a`, agent_status: `idle`, pane_title } ],
                list_stored_sessions_fn: () => [ { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w/repo`, title: stored_title } ],
                observe_activity_fn: async sessions => sessions,
            } )
        } )
        return result.rows[0]
    }

    it( `prefers the live title and flags it for saving when it changed`, async () => {
        expect( await render( `old`, `✳ New task` ) ).toMatchObject( { title: `New task`, fresh_title: true } )
        expect( await render( `New task`, `✳ New task` ) ).toMatchObject( { title: `New task`, fresh_title: false } )
    } )

    it( `hides a saved title that is only a placeholder`, async () => {
        expect( await render( `repo`, `repo` ) ).toMatchObject( { title: null } )
    } )

    it( `falls back to the saved title while the live one is a placeholder`, async () => {
        expect( await render( `Saved`, `repo` ) ).toMatchObject( { title: `Saved`, fresh_title: false } )
    } )

} )

describe( `shared numbering`, () => {

    const now = Date.now()
    const ago = hours => Math.floor( now / 1_000 ) - hours * 3_600
    const stored = [ `a`, `b`, `c`, `d` ].map( id => ( { tmux_session: `babysit_${ id }`, babysit_id: id, name: id, agent: `codex`, pwd: `/w/${ id }` } ) )
    const sessions = [
        { name: `babysit_a`, agent_status: `idle`, idle_since: ago( 60 ), last_opened: ago( 70 ) },
        { name: `babysit_b`, agent_status: `running`, last_opened: ago( 9 ) },
        { name: `babysit_c`, agent_status: `idle`, idle_since: ago( 2 ), last_opened: ago( 1 ) },
        { name: `babysit_d`, agent_status: `idle`, idle_since: ago( 30 ), last_opened: ago( 40 ) },
    ]

    it( `orders by last opened, with sessions idle over 24h at the end`, () => {
        expect( order_active_sessions( sessions, stored, { now } ).map( tmux => tmux.name ) )
            .toEqual( [ `babysit_c`, `babysit_b`, `babysit_d`, `babysit_a` ] )
    } )

    it( `is the numbering watch and list print`, async () => {
        let result
        await capture_console( async () => {
            result = await render_active_sessions( {
                version_check_fn: () => ( { latest: null } ),
                list_sessions_fn: async () => sessions,
                list_stored_sessions_fn: () => stored,
                observe_activity_fn: async list => list,
            } )
        } )
        expect( result.rows.map( row => [ row.number, row.target ] ) ).toEqual( [ [ 1, `c` ], [ 2, `b` ], [ 3, `d` ], [ 4, `a` ] ] )
    } )

    it( `counts a session as idle only when its agent is, and never for unstamped ones`, () => {
        expect( is_idle_session( { agent_status: `running`, idle_since: ago( 60 ) }, undefined, now ) ).toBe( false )
        expect( is_idle_session( { agent_status: `idle`, idle_since: null, shelved_since: null }, undefined, now ) ).toBe( false )
        expect( is_idle_session( { agent_status: `idle`, idle_since: ago( 60 ) }, { frozen_at: `x` }, now ) ).toBe( false )
        expect( is_idle_session( { agent_status: `idle`, idle_since: ago( 2 ), shelved_since: ago( 1 ) }, undefined, now ) ).toBe( true )
    } )

} )
