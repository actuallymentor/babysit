import { describe, expect, it } from 'bun:test'
import { hostname } from 'node:os'
import { Readable } from 'node:stream'

import { announce_reboot, cmd_reboot_notice, notice_targets } from '../src/sessions/reboot_notice.js'
import { REBOOT_NOTICE } from '../src/sessions/recovery.js'
import { parse_args } from '../src/cli/parse.js'

const stored = ( name, extra = {} ) => ( { babysit_id: name, tmux_session: `babysit_${ name }`, expected_open: true, host: hostname(), ...extra } )
const live = ( name, agent_status = `idle` ) => ( { name: `babysit_${ name }`, agent_status } )

// A clock that only moves when the code under test waits
const clock = () => {
    let time = 0
    return { now: () => time, wait_fn: async ms => {
        time += ms 
    } }
}

describe( `reboot notice targets`, () => {

    it( `skips sessions that cannot safely take typed input`, () => {
        const sessions = [
            stored( `idle` ), stored( `busy` ), stored( `dialog` ), stored( `gone` ),
            stored( `frozen`, { frozen_at: `2026-01-01` } ),
            stored( `preparing`, { status: `preparing` } ),
            stored( `continuing`, { continuation: `sending` } ),
            stored( `closed`, { expected_open: false } ),
            stored( `elsewhere`, { host: `another-host` } ),
            stored( `old`, { superseded_by: `idle` } ),
        ]
        const running = [ live( `idle` ), live( `busy`, `running` ), live( `dialog`, `waiting` ), live( `frozen` ), live( `preparing` ), live( `continuing` ), live( `closed` ), live( `elsewhere` ), live( `old` ) ]
        expect( notice_targets( sessions, running ).map( session => session.babysit_id ) ).toEqual( [ `idle`, `busy` ] )
    } )

} )

describe( `reboot announcement`, () => {

    it( `notifies every session at once and returns once agents stay idle`, async () => {
        const { now, wait_fn } = clock()
        const sent = []
        // Idle between the interrupted turn and the queued notice, then busy, then done
        const readings = [ `idle`, `idle`, `running`, `idle`, `idle` ]
        const count = await announce_reboot( {
            load: () => [ stored( `a` ), stored( `b` ) ],
            live: async () => [ live( `a`, readings.shift() || `idle` ), live( `b` ) ],
            send: async ( session, text ) => sent.push( [ session, text ] ),
            now, wait_fn, print: () => {},
        } )
        expect( sent ).toEqual( [ [ `babysit_a`, REBOOT_NOTICE ], [ `babysit_b`, REBOOT_NOTICE ] ] )
        expect( count ).toBe( 2 )
        expect( readings ).toEqual( [] )
        expect( now() ).toBeLessThan( 120_000 )
    } )

    it( `gives up at the grace period when an agent keeps working`, async () => {
        const { now, wait_fn } = clock()
        const lines = []
        await announce_reboot( {
            load: () => [ stored( `a` ) ],
            live: async () => [ live( `a`, `running` ) ],
            send: async () => {},
            now, wait_fn, print: line => lines.push( line ),
        } )
        expect( now() ).toBeGreaterThanOrEqual( 120_000 )
        expect( now() ).toBeLessThan( 130_000 )
        expect( lines.at( -1 ) ).toContain( `still working` )
    } )

    it( `does not wait when nothing could be notified`, async () => {
        const { now, wait_fn } = clock()
        const count = await announce_reboot( {
            load: () => [ stored( `a` ) ],
            live: async () => [ live( `a` ) ],
            send: async () => {
                throw new Error( `no pane` ) 
            },
            now, wait_fn, print: () => {},
        } )
        expect( count ).toBe( 0 )
        expect( now() ).toBe( 0 )
    } )

} )

describe( `reboot notice watcher`, () => {

    const listener = lines => {
        const child = { stdout: Readable.from( lines.map( line => `${ line }\n` ) ), killed: false, kill: () => {
            child.killed = true 
        } }
        return child
    }
    const signal = state => `/org/freedesktop/login1: org.freedesktop.login1.Manager.PrepareForShutdown (${ state },)`

    it( `announces once on the shutdown signal, then exits to release the lock`, async () => {
        let announced = 0
        const child = listener( [ `Monitoring signals on object /org/freedesktop/login1`, signal( `false` ), signal( `true` ), signal( `true` ) ] )
        await cmd_reboot_notice( { listen: () => child, announce: async () => {
            announced++ 
        }, print: () => {} } )
        expect( announced ).toBe( 1 )
        expect( child.killed ).toBe( true )
    } )

    it( `releases the lock even when the announcement fails`, async () => {
        const child = listener( [ signal( `true` ) ] )
        await cmd_reboot_notice( { listen: () => child, announce: async () => {
            throw new Error( `tmux gone` ) 
        }, print: () => {} } )
        expect( child.killed ).toBe( true )
    } )

    it( `fails when the listener dies so systemd restarts it`, async () => {
        const child = listener( [ signal( `false` ) ] )
        await expect( cmd_reboot_notice( { listen: () => child, announce: async () => {}, print: () => {} } ) ).rejects.toThrow( `Lost the logind signal listener` )
    } )

    it( `is a service-only recover flag that takes no recovery options`, () => {
        expect( parse_args( [ `recover`, `--notify` ] ).flags.notify ).toBe( true )
        expect( () => parse_args( [ `recover`, `--notify`, `--boot` ] ) ).toThrow( `--notify cannot be combined` )
    } )

} )
