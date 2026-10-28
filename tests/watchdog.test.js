import { describe, it, expect } from 'bun:test'
import { create_watchdog, CHECK_IN_NUDGE, WATCHDOG_NUDGE } from '../src/babysit/watchdog.js'
import { build_judge_prompt, judge_session, parse_verdict } from '../src/babysit/judge.js'
import { start_monitor } from '../src/babysit/monitor.js'

// Let a fire-and-forget check settle
const settle = () => new Promise( resolve => setTimeout( resolve, 0 ) )

const make_watchdog = ( overrides = {} ) => {

    const clock = { now: 0 }
    const calls = []
    const watchdog = create_watchdog( {
        session_name: `babysit_test`,
        idle_s: 1_800,
        waiting_s: 900,
        judge: async input => {
            calls.push( input )
            return { nudge: true, reason: `stalled`, judge: `claude` }
        },
        typed_at: async () => null,
        now: () => clock.now,
        ...overrides,
    } )

    return { watchdog, clock, calls }

}

describe( `watchdog`, () => {

    it( `judges an idle stretch once it outlasts the idle threshold, then nudges once`, async () => {
        const { watchdog, clock, calls } = make_watchdog()

        watchdog.observe( `idle` )
        clock.now = 1_799_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 0 )

        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toEqual( [ { status: `idle`, quiet_minutes: 30 } ] )
        expect( await watchdog.take( `idle` ) ).toBe( WATCHDOG_NUDGE )
        expect( await watchdog.take( `idle` ) ).toBeNull()

        // Judged once per stretch, however long it stays quiet
        clock.now = 99_000_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 1 )
    } )

    it( `checks in on a waiting agent without a judge, and again every threshold`, async () => {
        const { watchdog, clock, calls } = make_watchdog()

        watchdog.observe( `waiting` )
        clock.now = 899_000
        watchdog.observe( `waiting` )
        await settle()
        expect( await watchdog.take( `waiting` ) ).toBeNull()

        clock.now = 900_000
        watchdog.observe( `waiting` )
        await settle()
        expect( await watchdog.take( `waiting` ) ).toBe( CHECK_IN_NUDGE )
        expect( await watchdog.take( `waiting` ) ).toBeNull()

        // Still waiting and silent: the next check-in is a full threshold away
        clock.now = 1_799_000
        watchdog.observe( `waiting` )
        await settle()
        expect( await watchdog.take( `waiting` ) ).toBeNull()
        clock.now = 1_800_000
        watchdog.observe( `waiting` )
        await settle()
        expect( await watchdog.take( `waiting` ) ).toBe( CHECK_IN_NUDGE )

        expect( calls ).toHaveLength( 0 )
    } )

    it( `drops a check-in once the agent stopped waiting, is stuck, or the user typed`, async () => {
        const due = async overrides => {
            const made = make_watchdog( overrides )
            made.watchdog.observe( `waiting` )
            made.clock.now = 900_000
            made.watchdog.observe( `waiting` )
            await settle()
            return made.watchdog
        }

        expect( await ( await due() ).take( `idle` ) ).toBeNull()

        let stuck = false
        const stuck_dog = await due( { is_stuck: () => stuck } )
        stuck = true
        expect( await stuck_dog.take( `waiting` ) ).toBeNull()

        let typed = null
        const typing_dog = await due( { typed_at: async () => typed } )
        typed = 950_000
        expect( await typing_dog.take( `waiting` ) ).toBeNull()
    } )

    it( `starts a fresh stretch after the agent runs, dropping a stale nudge`, async () => {
        const { watchdog, clock, calls } = make_watchdog()

        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        watchdog.observe( `running` )
        expect( await watchdog.take( `idle` ) ).toBeNull()

        watchdog.observe( `idle` )
        clock.now = 3_599_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 1 )

        clock.now = 3_600_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 2 )
    } )

    it( `leaves parked agents alone`, async () => {
        const { watchdog, clock } = make_watchdog( { judge: async () => ( { nudge: false, reason: `asked a question`, judge: `claude` } ) } )
        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( await watchdog.take( `idle` ) ).toBeNull()
    } )

    it( `skips stuck sessions, disabled thresholds, and idle agents an idle rule already nudges`, async () => {
        for( const overrides of [ { is_stuck: () => true }, { idle_s: 0 }, { skips_idle: () => true } ] ) {
            const { watchdog, clock, calls } = make_watchdog( overrides )
            watchdog.observe( `idle` )
            clock.now = 10_000_000
            watchdog.observe( `idle` )
            await settle()
            expect( calls ).toHaveLength( 0 )
        }

        // An idle rule does not cover waiting
        const { watchdog, clock } = make_watchdog( { skips_idle: () => true } )
        watchdog.observe( `waiting` )
        clock.now = 900_000
        watchdog.observe( `waiting` )
        await settle()
        expect( await watchdog.take( `waiting` ) ).toBe( CHECK_IN_NUDGE )
    } )

    it( `restarts the stretch when the user typed, and retries after a failed judgment`, async () => {
        let typed = 1_000_000
        let verdict = null
        const { watchdog, clock, calls } = make_watchdog( {
            typed_at: async () => typed,
            judge: async input => {
                calls.push( input )
                return verdict
            },
        } )

        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 0 )

        // Quiet since the keypress; still short of the threshold
        clock.now = 2_799_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 0 )

        typed = null
        clock.now = 2_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 1 )

        // No verdict: wait a full threshold, then ask again
        verdict = { nudge: true, reason: `stalled`, judge: `codex` }
        clock.now = 4_599_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 1 )
        clock.now = 4_600_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 2 )
        expect( await watchdog.take( `idle` ) ).toBe( WATCHDOG_NUDGE )
    } )

    it( `drops a verdict when the user typed while the judge was thinking`, async () => {
        let typed = null
        const { watchdog, clock, calls } = make_watchdog( {
            typed_at: async () => typed,
            judge: async input => {
                calls.push( input )
                if( calls.length === 1 ) typed = clock.now + 1
                return { nudge: true, reason: `stalled`, judge: `claude` }
            },
        } )

        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 1 )
        expect( await watchdog.take( `idle` ) ).toBeNull()

        // The stretch restarted at the keypress, so it is judged again later
        typed = null
        clock.now = 3_600_001
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 2 )
        expect( await watchdog.take( `idle` ) ).toBe( WATCHDOG_NUDGE )
    } )

    it( `cancels a queued nudge when the user started typing before delivery`, async () => {
        let typed = null
        const { watchdog, clock } = make_watchdog( { typed_at: async () => typed } )
        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()

        typed = 1_800_500
        expect( await watchdog.take( `idle` ) ).toBeNull()
    } )

    it( `cancels a queued nudge when the session became stuck or covered by an idle rule`, async () => {
        for( const late of [ { stuck: true }, { idle_rule: true } ] ) {
            const state = { stuck: false, idle_rule: false }
            const { watchdog, clock } = make_watchdog( { is_stuck: () => state.stuck, skips_idle: () => state.idle_rule } )
            watchdog.observe( `waiting` )
            clock.now = 3_600_000
            watchdog.observe( `waiting` )
            await settle()
            Object.assign( state, late )
            expect( await watchdog.take( `idle` ) ).toBeNull()
        }
    } )

    it( `waits a full threshold after a judge throws`, async () => {
        const { watchdog, clock, calls } = make_watchdog( {
            judge: async input => {
                calls.push( input )
                throw new Error( `tmux capture failed` )
            },
        } )

        watchdog.observe( `idle` )
        clock.now = 1_800_000
        for( let tick = 0; tick < 3; tick++ ) {
            watchdog.observe( `idle` )
            await settle()
            clock.now += 1_000
        }
        expect( calls ).toHaveLength( 1 )
    } )

    it( `restarts on web companion input`, async () => {
        const { watchdog, clock, calls } = make_watchdog()
        watchdog.observe( `idle` )
        clock.now = 1_799_000
        watchdog.restart()
        watchdog.observe( `idle` )
        clock.now = 1_800_000
        watchdog.observe( `idle` )
        await settle()
        expect( calls ).toHaveLength( 0 )
    } )

} )

describe( `judge`, () => {

    it( `reads the last verdict out of a chatty reply`, () => {
        expect( parse_verdict( `banner\n{"nudge": false, "reason": "asked"}\n{"nudge": true, "reason": " waits on a   finished agent "}` ) )
            .toEqual( { nudge: true, reason: `waits on a finished agent` } )
        expect( parse_verdict( `{"nudge": "yes"}` ) ).toBeNull()
        expect( parse_verdict( `no json here` ) ).toBeNull()
    } )

    it( `describes the quiet state and keeps only the screen tail`, () => {
        const prompt = build_judge_prompt( { screen: `x`.repeat( 30_000 ) + `\nlast line\n\n`, status: `waiting`, quiet_minutes: 61 } )
        expect( prompt ).toContain( `no work for 61 minutes` )
        expect( prompt ).toContain( `still lists background` )
        expect( prompt ).toContain( `last line\n</terminal>` )
        // The nudge's opt-out reply must read as parked, or idle agents get nudged every stretch
        expect( WATCHDOG_NUDGE ).toContain( `reply "idle"` )
        expect( prompt ).toContain( `just "idle", answering an earlier nudge` )
        expect( prompt.length ).toBeLessThan( 26_000 )
    } )

    it( `runs Claude Haiku in the session container, falling back to Codex`, async () => {
        const commands = []
        const verdict = await judge_session( { container_id: `abc123`, screen: `done`, status: `idle`, quiet_minutes: 30 }, {
            run_command: async ( command, args ) => {
                commands.push( args )
                if( args.includes( `claude` ) ) throw new Error( `not logged in` )
                return `codex banner\n{"nudge": false, "reason": "finished"}`
            },
        } )

        expect( verdict ).toEqual( { nudge: false, reason: `finished`, judge: `codex` } )
        expect( commands[ 0 ].slice( 0, 8 ) ).toEqual( [ `exec`, `--user`, `node`, `--workdir`, `/tmp`, `abc123`, `bash`, `-c` ] )

        // Borrows the agent's environment and kills the judge itself on timeout
        expect( commands[ 0 ][ 8 ] ).toContain( `/proc/$agent/environ` )
        expect( commands[ 0 ][ 8 ] ).toContain( `exec timeout -k 5 110 "$@"` )
        expect( commands[ 0 ].slice( 9, 11 ) ).toEqual( [ `judge`, `claude` ] )
        expect( commands[ 0 ] ).toContain( `haiku` )
        expect( commands[ 0 ].at( -1 ) ).toBe( `` )
        expect( commands[ 1 ] ).toContain( `codex` )
    } )

    it( `returns null when no judge answers`, async () => {
        const verdict = await judge_session( { container_id: `abc123`, screen: ``, status: `idle`, quiet_minutes: 30 }, {
            run_command: async () => `I cannot comply`,
        } )
        expect( verdict ).toBeNull()
    } )

} )

describe( `monitor watchdog wiring`, () => {

    it( `types the nudge as a regular action, and only for the stretch it judged`, async () => {
        let tick = 0
        let queued = false
        const observed = []
        const sent = []
        const watchdog = {
            observe: status => {
                observed.push( status )
                if( tick === 1 ) queued = true
            },
            take: () => {
                const value = queued
                queued = false
                return value ? WATCHDOG_NUDGE : null
            },
        }

        await start_monitor( {
            session_name: `babysit_watchdog`,
            config: { idle_timeout_s: 300 },
            rules: [],
            agent: { name: `claude` },
            watchdog,
            has_session_fn: async () => tick < 4,
            capture_pane_fn: async () => `❯\n? for shortcuts`,
            publish_agent_status_fn: async ( { agent_status } ) => agent_status,
            execute_action_fn: async ( target, action ) => sent.push( [ tick, action ] ),
            write_loop_deadline_fn: () => {},
            wait_fn: async () => {
                await Promise.resolve()
                tick++
            },
        } )

        expect( observed ).toHaveLength( 4 )
        expect( sent ).toEqual( [ [ 1, WATCHDOG_NUDGE ] ] )
    } )

} )
