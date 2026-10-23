import { describe, it, expect } from 'bun:test'

import { cmd_freeze, frozen_status_label, set_container_paused } from '../src/cli/freeze.js'
import { start_monitor } from '../src/babysit/monitor.js'
import { close_session } from '../src/cli/recover.js'
import { print_active_sessions_table } from '../src/cli/list.js'
import { parse_args } from '../src/cli/parse.js'

const stored_session = ( id, extra = {} ) => ( {
    babysit_id: id, tmux_session: `babysit_${ id }`, name: `s${ id }`, agent: `codex`, pwd: `/w`,
    container_id: `c${ id }`, modifiers: [ `docker` ], ...extra,
} )

// A freeze run against an in-memory registry; events record the order of effects
const run_freeze = async ( verb, session_ids, { stored, mode = `host`, pause = async () => {} } = {} ) => {
    const events = []
    const records = new Map( stored.map( session => [ session.babysit_id, { ...session } ] ) )
    const code = await cmd_freeze( { verb, session_ids }, {
        mode: () => mode,
        list_sessions_fn: async () => stored.map( session => ( { name: session.tmux_session, attached: false } ) ),
        list_stored_sessions_fn: () => [ ...records.values() ],
        update_session_fn: ( id, updates ) => {
            events.push( `update ${ id } ${ updates.frozen_at ? `frozen` : `null` }` )
            Object.assign( records.get( id ), updates )
        },
        pause_fn: async ( container, paused ) => {
            events.push( `${ paused ? `pause` : `unpause` } ${ container }` )
            await pause( container )
        },
        label_fn: async ( tmux, label ) => events.push( `label ${ tmux } ${ label.endsWith( `FROZEN` ) ? `FROZEN` : `plain` }` ),
        wait_fn: async () => events.push( `settle` ),
        print: message => events.push( message ),
    } )
    return { code, events, records }
}

describe( `babysit freeze`, () => {

    it( `marks first so the monitor stands down, then pauses`, async () => {
        const { code, events, records } = await run_freeze( `freeze`, [ `1` ], { stored: [ stored_session( `a` ) ] } )
        expect( code ).toBe( 0 )
        expect( events.slice( 0, 4 ) ).toEqual( [ `update a frozen`, `settle`, `pause ca`, `label babysit_a FROZEN` ] )
        expect( records.get( `a` ).frozen_at ).toBeTruthy()
    } )

    it( `unfreezes by resuming first, then clearing the mark`, async () => {
        const { events, records } = await run_freeze( `unfreeze`, [ `all` ], { stored: [ stored_session( `a`, { frozen_at: `2026-10-23T00:00:00Z` } ), stored_session( `b` ) ] } )
        expect( events.slice( 0, 3 ) ).toEqual( [ `unpause ca`, `update a null`, `label babysit_a plain` ] )
        expect( events ).not.toContain( `unpause cb` )
        expect( records.get( `a` ).frozen_at ).toBeNull()
    } )

    it( `freeze all skips frozen and containerless sessions`, async () => {
        const { events } = await run_freeze( `freeze`, [ `all` ], { stored: [
            stored_session( `a`, { frozen_at: `2026-10-23T00:00:00Z` } ),
            stored_session( `b`, { container_id: null, modifiers: [] } ),
            stored_session( `c` ),
        ] } )
        expect( events.filter( event => event.startsWith( `pause` ) ) ).toEqual( [ `pause cc` ] )
    } )

    it( `refuses containerless sessions named outright`, async () => {
        const { code, events } = await run_freeze( `freeze`, [ `1` ], { stored: [ stored_session( `a`, { container_id: null, modifiers: [] } ) ] } )
        expect( code ).toBe( 1 )
        expect( events ).toContain( `sa runs without Docker; only Docker sessions can be frozen.` )
    } )

    it( `drops the mark when the pause fails`, async () => {
        const { code, records } = await run_freeze( `freeze`, [ `1` ], {
            stored: [ stored_session( `a` ) ],
            pause: async () => {
                throw new Error( `daemon gone` )
            },
        } )
        expect( code ).toBe( 1 )
        expect( records.get( `a` ).frozen_at ).toBeNull()
    } )

    it( `only runs on the host`, async () => {
        await expect( run_freeze( `freeze`, [ `all` ], { stored: [], mode: `container` } ) ).rejects.toThrow( `runs on the host` )
    } )

    it( `treats already paused or running containers as done`, async () => {
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args.at( -2 ) )
            throw new Error( `Container x is already paused` )
        }
        await set_container_paused( `x`, true, { run_command } )
        await expect( set_container_paused( `x`, false, { run_command: async () => {
            throw new Error( `boom` )
        } } ) ).rejects.toThrow( `boom` )
        expect( calls ).toEqual( [ `pause` ] )
    } )

    it( `labels the tmux bar`, () => {
        expect( frozen_status_label( stored_session( `a`, { pwd: `/x/y` } ), true ) ).toEndWith( ` · FROZEN` )
        expect( frozen_status_label( stored_session( `a`, { pwd: `/x/y` } ), false ) ).not.toContain( `FROZEN` )
    } )

    it( `parses selectors and requires one`, () => {
        expect( parse_args( [ `freeze`, `2`, `3` ] ) ).toMatchObject( { verb: `freeze`, session_ids: [ `2`, `3` ] } )
        expect( parse_args( [ `unfreeze`, `all` ] ) ).toMatchObject( { verb: `unfreeze`, session_ids: [ `all` ] } )
        expect( () => parse_args( [ `freeze` ] ) ).toThrow( `Usage: babysit freeze` )
    } )

} )

describe( `monitor while frozen`, () => {

    it( `captures and fires nothing while frozen, and restarts the idle clock on thaw`, async () => {
        let tick = 0
        let now = 1_000_000
        const captured = []
        const fired = []
        const original_now = Date.now
        Date.now = () => now
        try {
            await start_monitor( {
                session_name: `babysit_frozen`,
                config: { idle_timeout_s: 10 },
                rules: [ { on: { type: `idle` }, do: `nudge`, timeout_s: 10, last_fired_at: 0 } ],
                agent: { name: `codex` },
                // Frozen for ticks 1–4: twenty quiet seconds that must not count
                is_frozen: () => tick >= 1 && tick <= 4,
                has_session_fn: async () => tick < 8,
                capture_pane_fn: async () => {
                    captured.push( tick )
                    return `› same screen`
                },
                publish_agent_status_fn: async ( { agent_status } ) => agent_status,
                execute_action_fn: async () => fired.push( tick ),
                write_loop_deadline_fn: () => {},
                wait_fn: async () => {
                    await Promise.resolve()
                    tick++
                    now += 5_000
                },
            } )
        } finally {
            Date.now = original_now
        }
        expect( captured.filter( at => at >= 1 && at <= 4 ) ).toEqual( [] )
        // Thawed at tick 5: the 10s idle rule needs two more quiet ticks, not zero
        expect( fired[0] ).toBeGreaterThanOrEqual( 7 )
    } )

} )

describe( `frozen sessions elsewhere`, () => {

    it( `close unpauses before stopping`, async () => {
        const events = []
        const session = stored_session( `a`, { frozen_at: `2026-10-23T00:00:00Z`, monitor_pid: null } )
        await close_session( session, {}, {
            load: () => session,
            update: () => {},
            lock: () => () => {},
            identity: async () => ( {} ),
            sessions: async () => [],
            stop: async container => events.push( `stop ${ container }` ),
            unpause: async container => events.push( `unpause ${ container }` ),
            kill: async () => {},
            monitor_alive: () => true,
        } )
        expect( events ).toEqual( [ `unpause ca`, `stop ca` ] )
    } )

    it( `list shows frozen above stuck`, () => {
        const lines = []
        const original = console.log
        console.log = line => lines.push( String( line ?? `` ) )
        try {
            print_active_sessions_table( [ { name: `babysit_a`, attached: false, agent_status: `running` } ], [
                stored_session( `a`, { frozen_at: `2026-10-23T00:00:00Z`, stuck_at: `2026-10-23T00:00:00Z` } ),
            ], { numbered: true } )
        } finally {
            console.log = original
        }
        expect( lines.join( `\n` ) ).toMatch( /sa\s+frozen/ )
    } )

} )
