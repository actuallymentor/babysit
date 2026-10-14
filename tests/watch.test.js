import { describe, it, expect } from 'bun:test'
import { cmd_watch, format_usage_panel, short_limit_name, USAGE_REFRESH_MS } from '../src/cli/watch.js'
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

    it( `renders one aligned row per limit with meters and resets`, () => {
        const lines = format_usage_panel( report, { now: NOW } )
        expect( lines[0] ).toBe( `Account usage · 2m ago` )
        expect( lines[1] ).toMatch( /^ {2}claude\s+5h\s+▰▰▰▱▱▱▱▱▱▱\s+34%\s+↻ 2h 10m$/ )
        expect( lines[2] ).toMatch( /^ {2}\s+7d opus\s+▰▰▰▰▰▰▰▰▱▱\s+81%\s+↻ 3d 4h$/ )
        expect( lines[3] ).toMatch( /extra usage\s+3\.46 \/ 20 USD$/ )
        expect( lines[4] ).toMatch( /^ {2}codex\s+5h\s+▰/ )
        expect( lines[5] ).toMatch( /7d\s+▰▰▰▰▱▱▱▱▱▱\s+40%$/ )
        expect( lines ).toContain( `  opencode/openrouter error HTTP 500` )
        expect( lines ).toContain( `  signed out: antigravity` )
        // Columns line up across agents.
        expect( lines[1].indexOf( `▰` ) ).toBe( lines[4].indexOf( `▰` ) )
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
            render_sessions_fn: async ( { hide_archived, before_print } ) => {
                events.push( `render ${ hide_archived }` )
                before_print()
            },
            write_fn: text => events.push( JSON.stringify( text ) ),
            wait_fn: async () => {
                now += USAGE_REFRESH_MS / 2
                await tick()
            },
        } ) )

        expect( events.filter( event => event === `collect` ) ).toHaveLength( 2 )
        expect( events.filter( event => event === `render true` ) ).toHaveLength( 3 )
        expect( events ).toContain( JSON.stringify( `\x1b[H\x1b[J` ) )
        expect( output ).toContain( `claude` )
        expect( output ).toContain( `Ctrl+C to stop` )
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
