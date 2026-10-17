import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

import { create_account_switcher, plan_account_switch, spawn_account_restart, switch_targets } from '../src/babysit/account_switch.js'
import { shows_limit, start_monitor } from '../src/babysit/monitor.js'
import { claude } from '../src/agents/claude.js'

const fixture = name => readFileSync( new URL( `./fixtures/claude/${ name }`, import.meta.url ), `utf8` )

const NOW = Date.parse( `2026-10-17T12:00:00Z` )
const RESET = `2026-10-17T15:00:00.000Z`
const reading = ( name, used, extra = {} ) => ( {
    name, status: `ok`, headroom: Math.max( 0, 100 - used ),
    limits: [ { name: `session`, used_percent: used, resets_at: RESET }, { name: `weekly_all`, used_percent: Math.min( used, 30 ), resets_at: `2026-10-20T09:00:00.000Z` } ],
    ...extra,
} )

describe( `Claude limit detection`, () => {

    it( `matches the real limit wordings at the bottom of the pane`, () => {
        expect( shows_limit( fixture( `usage-limit-session.txt` ), claude ) ).toBe( true )
        const lines = [
            `  ⎿  You've hit your weekly limit · resets Oct 20, 9am (Europe/Amsterdam)`,
            `  ⎿  You’ve hit your Opus limit · resets 3pm`,
            `  ⎿  5-hour limit reached ∙ resets 3pm`,
            `Claude AI usage limit reached|1760713200`,
            `  Usage limit reached · continuing automatically at 3pm · esc to cancel`,
        ]
        lines.forEach( line => expect( shows_limit( `❯ work\n${ line }\n❯ `, claude ) ).toBe( true ) )
    } )

    it( `ignores spend caps, quotes scrolled out of view, and agents without a pattern`, () => {
        expect( shows_limit( `You've hit your monthly spend limit.\nYou're out of usage credits.`, claude ) ).toBe( false )
        expect( shows_limit( fixture( `usage-limit-quoted.txt` ), claude ) ).toBe( false )
        expect( shows_limit( fixture( `usage-limit-session.txt` ), { name: `codex` } ) ).toBe( false )
    } )

    it( `the monitor asks once, then waits out the recheck interval`, async () => {

        const screen = fixture( `usage-limit-session.txt` )
        const calls = []
        let ticks = 0
        await start_monitor( {
            session_name: `s`, config: {}, rules: [], agent: claude,
            on_limit_screen: name => calls.push( name ),
            has_session_fn: async () => ++ticks <= 3,
            capture_pane_fn: async () => screen,
            publish_agent_status_fn: async ( { agent_status } ) => agent_status,
            write_loop_deadline_fn: () => {},
            wait_fn: async () => {},
        } )
        expect( calls ).toEqual( [ `claude` ] )

    } )

} )

describe( `account switch guard`, () => {

    const session = { babysit_id: `b1`, agent_session_id: `n1`, claude_account: `default`, account_switches: [] }

    it( `moves to the account with most headroom and holds the guard until the exhausted reset`, () => {
        const plan = plan_account_switch( { session, readings: [ reading( `default`, 100 ), reading( `work`, 40 ), reading( `home`, 10 ) ], now: NOW } )
        expect( plan ).toEqual( { from: `default`, to: `home`, headroom: 90, resets_at: RESET } )
    } )

    it( `never returns to an account it left while that window is open: no ping-pong, but A→B→C`, () => {
        const switched = { ...session, claude_account: `home`, account_switches: [ { at: new Date( NOW ).toISOString(), from: `default`, to: `home`, resets_at: RESET } ] }

        // home spent too: work is still a fresh target, default is not
        const readings = [ reading( `default`, 0 ), reading( `home`, 100 ), reading( `work`, 40 ) ]
        expect( plan_account_switch( { session: switched, readings, now: NOW + 60_000 } ) ).toMatchObject( { from: `home`, to: `work` } )

        // Only default left, and it was left this window
        const pair = [ reading( `default`, 0 ), reading( `home`, 100 ) ]
        expect( plan_account_switch( { session: switched, readings: pair, now: NOW + 60_000 } ).skip ).toMatch( /already hit its limit/ )
        // After the reset default is a target again
        expect( plan_account_switch( { session: switched, readings: pair, now: Date.parse( RESET ) + 1 } ) ).toMatchObject( { from: `home`, to: `default` } )
    } )

    it( `a session still on the account it just left waits for that restart`, () => {
        const pending = { ...session, account_switches: [ { at: new Date( NOW ).toISOString(), from: `default`, to: `work`, resets_at: RESET } ] }
        expect( switch_targets( { session: pending, names: [ `default`, `work`, `home` ], now: NOW } ).skip ).toMatch( /already under way/ )
    } )

    it( `an unknown reset blocks for a five hour window`, () => {
        const switched = { ...session, account_switches: [ { at: new Date( NOW ).toISOString(), from: `work`, to: `default`, resets_at: null } ] }
        const readings = [ reading( `default`, 100 ), reading( `work`, 0 ) ]
        expect( plan_account_switch( { session: switched, readings, now: NOW + 4 * 3600_000 } ).skip ).toBeDefined()
        expect( plan_account_switch( { session: switched, readings, now: NOW + 5 * 3600_000 + 1 } ) ).toMatchObject( { to: `work` } )
    } )

    it( `stays put when the current account still has headroom (a quoted message)`, () => {
        expect( plan_account_switch( { session, readings: [ reading( `default`, 60 ), reading( `work`, 0 ) ], now: NOW } ).skip ).toBe( `default still has 40% left` )
    } )

    it( `does nothing when no other account has headroom`, () => {
        const plan = plan_account_switch( { session, readings: [ reading( `default`, 100 ), reading( `work`, 100 ), { name: `home`, status: `error`, headroom: null, limits: [] } ], now: NOW } )
        expect( plan ).toEqual( { skip: `no other Claude account has headroom`, exhausted: true } )
    } )

    it( `a failed probe of the current account still lets the pane evidence count`, () => {
        const readings = [ { name: `default`, status: `error`, headroom: null, limits: [] }, reading( `work`, 10 ) ]
        expect( plan_account_switch( { session, readings, now: NOW } ) ).toEqual( { from: `default`, to: `work`, headroom: 90, resets_at: null } )
    } )

} )

describe( `account switcher`, () => {

    const accounts = [ { name: `default`, token: `a` }, { name: `work`, token: `b` } ]
    const harness = ( { record = {}, readings = [ reading( `default`, 100 ), reading( `work`, 20 ) ], list = () => accounts, attached = false } = {} ) => {
        const state = { babysit_id: `b1`, agent_session_id: `n1`, claude_account: `default`, account_switches: [], tmux_session: `t1`, ...record }
        const calls = { restarts: [], notes: [], probes: [] }
        const switcher = create_account_switcher( state, {
            list,
            probe: async ( probed, options ) => calls.probes.push( [ probed.map( ( { name } ) => name ), options ] ) && readings,
            load: () => state,
            update: ( id, change ) => Object.assign( state, change( state ) ),
            attached: async () => typeof attached === `function` ? attached() : attached,
            notify: async note => calls.notes.push( note.message ),
            restart: ( id, account ) => calls.restarts.push( [ id, account ] ),
            now: () => NOW,
        } )
        return { state, calls, switcher }
    }

    it( `records the switch, then restarts on the new account with near-fresh probes`, async () => {
        const { state, calls, switcher } = harness()
        expect( await switcher() ).toMatchObject( { from: `default`, to: `work` } )
        expect( calls.probes ).toEqual( [ [ [ `default`, `work` ], { max_age_ms: 60_000 } ] ] )
        expect( calls.restarts ).toEqual( [ [ `b1`, `work` ] ] )
        expect( state.account_switches ).toEqual( [ { at: new Date( NOW ).toISOString(), from: `default`, to: `work`, resets_at: RESET } ] )
        expect( calls.notes[ 0 ] ).toContain( `moved b1 to work` )

        // The limit screen lingers until the session closes: no second restart, no probe
        await switcher()
        expect( calls.restarts.length ).toBe( 1 )
        expect( calls.probes.length ).toBe( 1 )
    } )

    it( `a stale limit line after the switch is settled by the guard, without probing`, async () => {
        const { calls, switcher } = harness( { record: {
            claude_account: `work`,
            account_switches: [ { at: new Date( NOW ).toISOString(), from: `default`, to: `work`, resets_at: RESET } ],
        } } )
        expect( ( await switcher() ).skip ).toMatch( /already hit its limit/ )
        expect( calls.probes ).toEqual( [] )
        expect( calls.notes ).toEqual( [] )
    } )

    it( `probes only the current account and real targets`, async () => {
        const three = [ ...accounts, { name: `home`, token: `c` } ]
        const { calls, switcher } = harness( {
            list: () => three,
            readings: [ reading( `work`, 100 ), reading( `home`, 10 ) ],
            record: { claude_account: `work`, account_switches: [ { at: new Date( NOW ).toISOString(), from: `default`, to: `work`, resets_at: RESET } ] },
        } )
        expect( await switcher() ).toMatchObject( { from: `work`, to: `home` } )
        expect( calls.probes[ 0 ][ 0 ] ).toEqual( [ `work`, `home` ] )
    } )

    it( `waits while someone is attached, says so once, and switches after they detach`, async () => {
        let attached = true
        const { calls, switcher } = harness( { attached: () => attached } )
        expect( await switcher() ).toEqual( { skip: `attached`, to: `work` } )
        await switcher()
        expect( calls.restarts ).toEqual( [] )
        expect( calls.notes ).toEqual( [ `Claude limit hit on default in b1; detach to let babysit switch to work.` ] )

        attached = false
        expect( await switcher() ).toMatchObject( { to: `work` } )
        expect( calls.restarts ).toEqual( [ [ `b1`, `work` ] ] )
    } )

    it( `never restarts without a native id, in a sandbox, or with one account`, async () => {
        for( const options of [ { record: { agent_session_id: null } }, { record: { modifiers: [ `sandbox` ] } }, { list: () => accounts.slice( 0, 1 ) } ] ) {
            const { calls, switcher } = harness( options )
            await switcher()
            expect( calls.restarts ).toEqual( [] )
            expect( calls.probes ).toEqual( [] )
        }
    } )

    it( `all accounts spent: notifies once, restarts nothing`, async () => {
        const { calls, switcher } = harness( { readings: [ reading( `default`, 100 ), reading( `work`, 100 ) ] } )
        await switcher()
        await switcher()
        expect( calls.restarts ).toEqual( [] )
        expect( calls.notes.length ).toBe( 1 )
    } )

    it( `spawns a detached restart that resumes, continues and switches the account`, () => {
        const spawned = []
        spawn_account_restart( `b1`, `work`, {
            command: [ `/usr/bin/babysit` ],
            log_path: `/dev/null`,
            spawn_fn: ( bin, args, options ) => {
                spawned.push( { bin, args, detached: options.detached } )
                return { on: () => {}, unref: () => {} }
            },
        } )
        expect( spawned ).toEqual( [ { bin: `/usr/bin/babysit`, args: [ `restart`, `b1`, `--force`, `--detach`, `--continue`, `--account`, `work` ], detached: true } ] )
    } )

} )
