import { describe, it, expect } from 'bun:test'

import { execute_action, execute_segments, wait_for_idle } from '../src/babysit/actions.js'

describe( `special babysit actions`, () => {

    it( `maps enter to the Enter key`, async () => {

        const sent = []

        await execute_action( `session`, `enter`, {}, {
            send_enter_fn: session => sent.push( [ `enter`, session ] ),
        } )

        expect( sent ).toEqual( [ [ `enter`, `session` ] ] )

    } )

} )

// A channel stand-in whose turn advances as the test scripts it
const channel = ( { reports_turns = true } = {} ) => {
    let seq = 0
    let turn = null
    return {
        tick() {},
        reports_turns: () => reports_turns,
        last_seq: () => seq,
        turn: () => turn,
        start: () => { turn = { state: `open`, started_seq: ++seq } },
        complete: ( status = `completed` ) => { turn = { ...turn, state: `closed`, status, seq: ++seq } },
    }
}

// Clocked pane: changes every poll unless `still`
const pane = () => {
    let now = 0
    let frame = 0
    const state = { still: false, polls: 0 }
    return {
        state,
        options: {
            now_fn: () => now,
            capture_pane_fn: async () => state.still ? `still` : `frame ${ frame++ }`,
            wait_fn: async () => {
                state.polls++
                now += 2_000
                state.on_poll?.( state.polls )
            },
        },
    }
}

describe( `segment pacing`, () => {

    it( `ends at the segment's own turn_completed, long before 30s of quiet`, async () => {
        const events = channel()
        const { state, options } = pane()
        const mark = events.last_seq()
        state.on_poll = polls => {
            if( polls === 1 ) events.start()
            if( polls === 3 ) events.complete()
        }
        expect( await wait_for_idle( `s`, { ...options, launch_channel: events, mark } ) ).toBe( `event` )
        expect( state.polls ).toBe( 3 )
    } )

    it( `an interrupted or failed turn also ends the wait`, async () => {
        const events = channel()
        const { state, options } = pane()
        state.on_poll = () => {
            events.start()
            events.complete( `interrupted` )
        }
        expect( await wait_for_idle( `s`, { ...options, launch_channel: events, mark: 0 } ) ).toBe( `event` )
    } )

    it( `ignores a completion of a turn that started before the segment was typed`, async () => {
        const events = channel()
        events.start()
        const mark = events.last_seq()
        const { state, options } = pane()
        state.on_poll = polls => {
            if( polls === 1 ) events.complete()
            if( polls === 2 ) state.still = true
        }
        expect( await wait_for_idle( `s`, { ...options, launch_channel: events, mark } ) ).toBe( `pane` )
        expect( state.polls ).toBeGreaterThanOrEqual( 15 )
    } )

    it( `falls back to 30s of quiet: no channel, no turn reports, or a turn that never closes`, async () => {
        for( const launch_channel of [ null, channel( { reports_turns: false } ), channel() ] ) {
            const { state, options } = pane()
            launch_channel?.start()
            state.on_poll = polls => {
                if( polls === 2 ) state.still = true
            }
            expect( await wait_for_idle( `s`, { ...options, launch_channel, mark: 0 } ) ).toBe( `pane` )
        }
    } )

    it( `marks the channel before each segment is typed`, async () => {
        const events = channel()
        const typed = []
        // Each typed segment runs a turn to completion before the next poll
        await execute_segments( `s`, [ `one`, `two`, `three` ], {
            launch_channel: events,
            send_text_fn: async ( _, text ) => {
                typed.push( [ text, events.last_seq() ] )
                events.start()
                events.complete()
            },
        } )
        expect( typed ).toEqual( [ [ `one`, 0 ], [ `two`, 2 ], [ `three`, 4 ] ] )
    } )

} )
