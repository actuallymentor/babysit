import { describe, expect, it } from 'bun:test'

import {
    create_docker_file_transport,
    inspect_docker_container_state,
    normalise_local_sync_file,
    remove_docker_container,
    stop_docker_container,
    wait_for_docker_container_stopped,
} from '../src/docker/file_transport.js'

describe( `Docker credential file transport`, () => {

    it( `inspects and stops a surviving named container`, async () => {

        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( [ command, ...args ] )
            return args.includes( `inspect` ) ? `running` : ``
        }

        expect( await inspect_docker_container_state( `babysit-session`, { run_command } ) ).toBe( `running` )
        expect( await stop_docker_container( `babysit-session`, { run_command } ) ).toBe( true )
        expect( calls ).toEqual( [
            [ `docker`, `inspect`, `--format`, `{{.State.Status}}`, `babysit-session` ],
            [ `docker`, `stop`, `--time`, `10`, `babysit-session` ],
        ] )

    } )

    it( `treats an already-removed container as recovered`, async () => {

        const run_command = async () => {
            throw new Error( `docker exited with code 1: Error: No such container: missing` )
        }

        expect( await inspect_docker_container_state( `missing`, { run_command } ) ).toBeNull()
        expect( await stop_docker_container( `missing`, { run_command } ) ).toBe( false )

    } )

    it( `pulls and pushes through docker cp using client-local paths`, async () => {

        const calls = []
        const transport = create_docker_file_transport(
            `a`.repeat( 64 ),
            `/home/node/.codex/auth.json`,
            {
                run_command: async ( command, args, options, timeout_ms ) => {
                    calls.push( { command, args, options, timeout_ms } )
                },
                normalise_local_file: async () => {},
            }
        )

        await transport.pull( `/tmp/codex-auth.json` )
        await transport.push( `/tmp/codex-auth.json` )

        expect( calls.map( call => call.args ) ).toEqual( [
            [ `cp`, `${ `a`.repeat( 64 ) }:/home/node/.codex/auth.json`, `/tmp/codex-auth.json` ],
            [ `cp`, `/tmp/codex-auth.json`, `${ `a`.repeat( 64 ) }:/home/node/.codex/auth.json` ],
        ] )
        expect( calls.every( call => call.command === `docker` ) ).toBe( true )
        expect( calls.every( call => call.timeout_ms === 60_000 ) ).toBe( true )

    } )

    it( `repairs sudo-owned mode-0666 pulls before the next container push`, async () => {

        const calls = []
        const chmod_calls = []

        await normalise_local_sync_file( `/tmp/codex-auth.json`, {
            command_prefix: [ `sudo`, `docker` ],
            stat_sync: () => ( { mode: 0o100666, uid: 0, gid: 0 } ),
            chmod_sync: ( path, mode ) => {
                chmod_calls.push( { path, mode } )
                if( chmod_calls.length === 1 ) {
                    const error = new Error( `not owner` )
                    error.code = `EPERM`
                    throw error
                }
            },
            uid: 1001,
            gid: 1002,
            run_command: async ( command, args, options, timeout_ms ) => {
                calls.push( { command, args, options, timeout_ms } )
            },
        } )

        expect( calls ).toEqual( [ {
            command: `sudo`,
            args: [ `chown`, `1001:1002`, `/tmp/codex-auth.json` ],
            options: {},
            timeout_ms: 30_000,
        } ] )
        expect( chmod_calls ).toEqual( [
            { path: `/tmp/codex-auth.json`, mode: 0o666 },
            { path: `/tmp/codex-auth.json`, mode: 0o666 },
        ] )

    } )

    it( `removes a staged container after the final credential flush`, async () => {

        const calls = []
        await remove_docker_container( `b`.repeat( 64 ), {
            run_command: async ( command, args, options, timeout_ms ) => {
                calls.push( { command, args, options, timeout_ms } )
            },
        } )

        expect( calls ).toEqual( [ {
            command: `docker`,
            args: [ `rm`, `-f`, `b`.repeat( 64 ) ],
            options: {},
            timeout_ms: 30_000,
        } ] )

    } )

    it( `waits through Docker exit bookkeeping before credential cleanup`, async () => {
        const statuses = [ `running`, `running`, `exited` ]
        const waits = []
        let now = 0

        const status = await wait_for_docker_container_stopped( `c`.repeat( 64 ), {
            run_command: async () => statuses.shift(),
            wait_fn: async delay_ms => {
                waits.push( delay_ms )
                now += delay_ms
            },
            now: () => now,
            timeout_ms: 1_000,
            poll_interval_ms: 100,
        } )

        expect( status ).toBe( `exited` )
        expect( waits ).toEqual( [ 100, 100 ] )
    } )

    it( `fails closed when Docker never reaches a copy-safe stopped state`, async () => {
        let now = 0

        const result = wait_for_docker_container_stopped( `d`.repeat( 64 ), {
            run_command: async () => `running`,
            wait_fn: async delay_ms => {
                now += delay_ms
            },
            now: () => now,
            timeout_ms: 250,
            poll_interval_ms: 100,
        } )

        await expect( result ).rejects.toThrow( /did not stop within 250ms/ )
    } )

} )
