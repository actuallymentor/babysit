import { describe, it, expect } from 'bun:test'
import { cmd_watch, format_usage_panel, limit_percent, session_usage_limits, short_limit_name, usage_cell, usage_level, USAGE_REFRESH_MS } from '../src/cli/watch.js'
import { render_active_sessions } from '../src/cli/list.js'

const capture_console = async fn => {
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

// Lets the background usage refresh settle between frames.
const tick = () => new Promise( resolve => setTimeout( resolve, 0 ) )

const NOW = Date.parse( `2026-10-14T12:00:00Z` )
const report = {
    fetched_at: `2026-10-14T11:58:00Z`,
    agents: [
        { agent: `claude`, provider: `anthropic`, status: `ok`, limits: [
            { name: `five_hour`, used_percent: 34, resets_at: `2026-10-14T14:10:00Z` },
            { name: `seven_day_opus`, used_percent: 81, resets_at: `2026-10-17T16:00:00Z` },
            { name: `extra usage`, unit: `USD`, used: 3.456789, limit: 20 },
        ] },
        { agent: `codex`, provider: `openai`, status: `ok`, limits: [
            { name: `nothing reported` },
            { name: `codex / 300 min`, used_percent: 12, resets_at: `2026-10-14T16:00:00Z` },
            { name: `codex / 10080 min`, used_percent: 40, resets_at: null },
            { name: `credit balance`, unit: `credits`, remaining: `0`, unlimited: true },
        ] },
        { agent: `opencode`, provider: `openrouter`, status: `error`, message: `HTTP 5\x0700`, limits: [] },
        { agent: `antigravity`, provider: `google`, status: `unauthenticated`, limits: [] },
    ],
}

describe( `short_limit_name`, () => {

    it( `turns provider window names into 5h / 7d`, () => {
        expect( short_limit_name( `five_hour`, `claude` ) ).toBe( `5h` )
        expect( short_limit_name( `seven_day`, `claude` ) ).toBe( `7d` )
        expect( short_limit_name( `seven_day_opus`, `claude` ) ).toBe( `7d opus` )
        expect( short_limit_name( `weekly_all`, `claude` ) ).toBe( `7d` )
        expect( short_limit_name( `codex / 300 min`, `codex` ) ).toBe( `5h` )
        expect( short_limit_name( `codex / 10080 min`, `codex` ) ).toBe( `7d` )
        expect( short_limit_name( `code_review / 300 min`, `codex` ) ).toBe( `code review / 5h` )
        expect( short_limit_name( `weekly_scoped / Fable`, `claude` ) ).toBe( `7d Fable` )
        expect( short_limit_name( `API key / daily`, `opencode` ) ).toBe( `daily` )
    } )

} )

describe( `format_usage_panel`, () => {

    it( `shows loading before the first report`, () => {
        expect( format_usage_panel( null, { now: NOW } ) ).toEqual( [ `Account usage · loading…` ] )
    } )

    it( `renders one metered row per limit, dropping balances and signed-out agents`, () => {
        const lines = format_usage_panel( report, { now: NOW } )
        expect( lines[0] ).toBe( `Account usage · 2m ago` )
        expect( lines[1] ).toMatch( /^ {2}claude\s+5h\s+▰▰▰▱▱▱▱▱▱▱\s+34%\s+↻ 2h 10m$/ )
        expect( lines[2] ).toMatch( /^ {2}\s+7d opus\s+▰▰▰▰▰▰▰▰▱▱\s+81%\s+↻ 3d 4h$/ )
        // No provider percentage: used ÷ limit drives the meter.
        expect( lines[3] ).toMatch( /extra usage\s+▰▰▱▱▱▱▱▱▱▱\s+17%\s+3\.46 \/ 20 USD$/ )
        expect( lines[4] ).toMatch( /^ {2}codex\s+5h\s+▰/ )
        expect( lines[5] ).toMatch( /7d\s+▰▰▰▰▱▱▱▱▱▱\s+40%$/ )
        expect( lines[6] ).toBe( `  opencode/openrouter error HTTP 500` )
        expect( lines ).toHaveLength( 7 )
        expect( lines.join( `\n` ) ).not.toMatch( /credit|antigravity|lifetime/ )
        // Columns line up across agents.
        expect( lines[1].indexOf( `▰` ) ).toBe( lines[4].indexOf( `▰` ) )
    } )

} )

describe( `limit_percent`, () => {

    it( `prefers provider percentages, then used over limit`, () => {
        expect( limit_percent( { used_percent: 12 } ) ).toBe( 12 )
        expect( limit_percent( { remaining_percent: 70 } ) ).toBe( 30 )
        expect( limit_percent( { used: 0, limit: 20 } ) ).toBe( 0 )
        expect( limit_percent( { used: 250, limit: `1000` } ) ).toBe( 25 )
        expect( limit_percent( { used: 26.39 } ) ).toBeNull()
        expect( limit_percent( { remaining: `242`, unlimited: true } ) ).toBeNull()
        expect( limit_percent( { used: 5, limit: 0 } ) ).toBeNull()
    } )

} )

// One rate window at a given remaining share
const window_left = remaining => ( { name: `five_hour`, kind: `window`, used_percent: 100 - remaining } )

describe( `usage_level`, () => {

    it( `walks the waterfall on remaining %, first hit wins`, () => {
        const labels = [ 0, 4.9, 5, 19.9, 20, 39.9, 40, 100 ].map( remaining => usage_level( [ window_left( remaining ) ] )?.label )
        expect( labels ).toEqual( [ `critical`, `critical`, `low`, `low`, `fine`, `fine`, `plenty`, `plenty` ] )
        expect( usage_level( [ window_left( 4.9 ) ] ).color ).toBe( `red` )
        expect( usage_level( [ window_left( 19.9 ) ] ).color ).toBe( `orange` )
        expect( usage_level( [ window_left( 39.9 ) ] ).color ).toBe( `green` )
        expect( usage_level( [ window_left( 40 ) ] ).color ).toBe( `green` )
    } )

    it( `takes the worst window`, () => {
        expect( usage_level( [ window_left( 90 ), window_left( 12 ), window_left( 60 ) ] ) ).toEqual( { label: `low`, color: `orange`, remaining: 12 } )
    } )

    it( `ignores extra usage, spend caps, balances and lifetime spend`, () => {
        const limits = [
            window_left( 70 ),
            { name: `extra usage`, unit: `USD`, used: 19.9, limit: 20, used_percent: 99.5 },
            { name: `codex / individual limit`, unit: `credits`, remaining_percent: 1 },
            { name: `API key / daily`, unit: `USD`, used: 9.9, limit: 10 },
            { name: `credit balance`, unit: `credits`, remaining: `0` },
            { name: `API key / lifetime spend`, unit: `USD`, used: 500 },
        ]
        expect( usage_level( limits ).label ).toBe( `plenty` )
        expect( usage_level( limits.slice( 1 ) ) ).toBeNull()
    } )

    it( `is null without data`, () => {
        expect( usage_level( null ) ).toBeNull()
        expect( usage_level( [] ) ).toBeNull()
        expect( usage_level( [ { name: `five_hour`, kind: `window`, used_percent: null } ] ) ).toBeNull()
    } )

} )

describe( `session_usage_limits`, () => {

    it( `reads the healthy entries for the session's agent`, () => {
        expect( session_usage_limits( report, { agent: `claude` } ) ).toHaveLength( 3 )
        expect( session_usage_limits( report, { agent: `opencode` } ) ).toEqual( [] )
        expect( session_usage_limits( report, undefined ) ).toEqual( [] )
        expect( session_usage_limits( null, { agent: `claude` } ) ).toEqual( [] )
    } )

    it( `counts only the session's own Claude account`, () => {

        const window = used_percent => ( { name: `five_hour`, kind: `window`, used_percent } )
        const accounts = { agents: [
            { agent: `claude`, account: `default`, status: `ok`, limits: [ window( 10 ) ] },
            { agent: `claude`, account: `work`, status: `ok`, limits: [ window( 99 ) ] },
        ] }

        expect( session_usage_limits( accounts, { agent: `claude`, claude_account: `work` } ) ).toEqual( [ window( 99 ) ] )
        expect( session_usage_limits( accounts, { agent: `claude` } ) ).toEqual( [ window( 10 ) ] )

    } )

} )

describe( `usage_cell`, () => {

    it( `labels headroom with the floored remaining %, dim dash without data`, () => {
        const marked = { ...report, agents: report.agents.map( result => ( {
            ...result,
            limits: result.limits.map( limit => /min$|five_hour|seven_day/.test( limit.name ) ? { ...limit, kind: `window` } : limit ),
        } ) ) }
        // Claude: 5h at 34% used, 7d opus at 81% used → 19% left
        expect( usage_cell( marked, { agent: `claude` } ) ).toEqual( { text: `low 19%`, color: `orange` } )
        expect( usage_cell( marked, { agent: `codex` } ) ).toEqual( { text: `plenty 60%`, color: `green` } )
        expect( usage_cell( marked, { agent: `antigravity` } ) ).toEqual( { text: `—`, color: `dim` } )
        expect( usage_cell( null, { agent: `claude` } ) ).toEqual( { text: `—`, color: `dim` } )
    } )

} )

describe( `cmd_watch`, () => {

    it( `redraws sessions plus usage, refreshing usage on its own cadence`, async () => {
        let now = NOW
        const events = []
        const output = await capture_console( () => cmd_watch( { flags: {} }, {
            rounds: 3,
            now_fn: () => now,
            collect_fn: async options => {
                events.push( `collect` )
                // The token-rotating Codex app-server fallback stays off.
                expect( await options.codex_read() ).toBeNull()
                return report
            },
            render_sessions_fn: async ( { hide_archived, open_hint, before_print } ) => {
                events.push( `render ${ hide_archived } ${ open_hint }` )
                before_print()
            },
            write_fn: text => events.push( JSON.stringify( text ) ),
            wait_fn: async () => {
                now += USAGE_REFRESH_MS / 2
                await tick()
            },
        } ) )

        expect( events.filter( event => event === `collect` ) ).toHaveLength( 2 )
        expect( events.filter( event => event === `render true false` ) ).toHaveLength( 3 )
        expect( events ).toContain( JSON.stringify( `\x1b[H\x1b[J` ) )
        expect( output ).toContain( `claude` )
        expect( output ).toContain( `Ctrl+C to stop` )
    } )

    it( `renders a USAGE column per session row through the real session tree`, async () => {
        const output = await capture_console( () => cmd_watch( { flags: {} }, {
            rounds: 2,
            collect_fn: async () => ( { fetched_at: new Date().toISOString(), agents: [
                { agent: `claude`, status: `ok`, limits: [ { name: `five_hour`, kind: `window`, used_percent: 97 } ] },
                { agent: `codex`, status: `ok`, limits: [ { name: `codex / 300 min`, kind: `window`, used_percent: 10 } ] },
            ] } ),
            render_sessions_fn: options => render_active_sessions( {
                ...options,
                version_check_fn: () => ( { latest: null } ),
                list_sessions_fn: async () => [
                    { name: `babysit_a`, attached: false, agent_status: `idle` },
                    { name: `babysit_b`, attached: false, agent_status: `idle` },
                    { name: `babysit_c`, attached: false, agent_status: `idle` },
                ],
                list_stored_sessions_fn: () => [
                    { tmux_session: `babysit_a`, name: `a`, agent: `claude`, babysit_id: `a`, pwd: `/w` },
                    { tmux_session: `babysit_b`, name: `b`, agent: `codex`, babysit_id: `b`, pwd: `/w` },
                    { tmux_session: `babysit_c`, name: `c`, agent: `opencode`, babysit_id: `c`, pwd: `/w` },
                ],
                observe_activity_fn: async sessions => sessions,
            } ),
            write_fn: () => {},
            wait_fn: tick,
        } ) )

        // The last frame has the report; the first rendered before it landed
        const frame = output.slice( output.lastIndexOf( `Active babysit sessions` ) )
        expect( frame ).toMatch( /MEM\s+USAGE\s+FLAGS/ )
        expect( frame ).toMatch( /a\s.*critical 3%/ )
        expect( frame ).toMatch( /b\s.*plenty 90%/ )
        expect( frame ).toMatch( /c\s.*—/ )
    } )

    it( `keeps drawing when a usage refresh fails`, async () => {
        const output = await capture_console( () => cmd_watch( {}, {
            rounds: 2,
            collect_fn: async () => {
                throw new Error( `offline` )
            },
            render_sessions_fn: async () => {},
            write_fn: () => {},
            wait_fn: tick,
        } ) )
        expect( output ).toContain( `refresh failed: offline` )
    } )

} )

describe( `render_active_sessions`, () => {

    it( `hides archived sessions but keeps global numbers`, async () => {
        const output = await capture_console( () => render_active_sessions( {
            hide_archived: true,
            version_check_fn: () => ( { latest: null } ),
            list_sessions_fn: async () => [
                { name: `babysit_a`, attached: false, agent_status: `idle` },
                { name: `babysit_old`, attached: false, agent_status: `idle` },
                { name: `babysit_b`, attached: false, agent_status: `idle` },
            ],
            list_stored_sessions_fn: () => [
                { tmux_session: `babysit_a`, name: `a`, agent: `codex`, babysit_id: `a`, pwd: `/w` },
                { tmux_session: `babysit_old`, name: `old`, agent: `codex`, babysit_id: `old`, pwd: `/w`, archived_at: `2026-01-01T00:00:00.000Z` },
                { tmux_session: `babysit_b`, name: `b`, agent: `codex`, babysit_id: `b`, pwd: `/other` },
            ],
            observe_activity_fn: async sessions => sessions,
        } ) )

        expect( output ).not.toContain( `old` )
        expect( output ).toMatch( /1\s+a\s/ )
        expect( output ).toMatch( /3\s+b\s/ )
    } )

    it( `points at plain list when every active session is archived`, async () => {
        const output = await capture_console( () => render_active_sessions( {
            hide_archived: true,
            list_sessions_fn: async () => [ { name: `babysit_old`, attached: false } ],
            list_stored_sessions_fn: () => [ { tmux_session: `babysit_old`, babysit_id: `old`, pwd: `/w`, archived_at: `2026-01-01T00:00:00.000Z` } ],
        } ) )
        expect( output ).toContain( `No unarchived babysit sessions. Run babysit list to see archived ones.` )
    } )

} )
