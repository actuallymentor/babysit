import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'

import { opencode } from '../src/agents/opencode.js'
import { prepare_docker_launch } from '../src/docker/launch.js'
import { build_private_tmpfile } from '../src/utils/tmpfile.js'

const CONTAINER_ID = `a`.repeat( 64 )

const make_options = copy_mount => ( {
    agent: opencode,
    workspace: `/tmp/empty`,
    mode: {
        yolo: true,
        ignore_host_agents_md: true,
    },
    agent_args: [],
    creds_mounts: [
        copy_mount,
        {
            type: `env`,
            key: `GH_CONFIG_DIR`,
            value: `/home/node/.config/babysit-gh`,
        },
    ],
    config: { isolate_dependencies: false },
    extra_env: {},
    modifiers: [ `yolo`, `ignore-host-agents-md` ],
    interactive: true,
    mount_workspace: false,
    include_agents_dir: false,
    include_user_globals: false,
    include_loop_deadline: false,
    include_agent_state: false,
} )

const private_transport = () => {

    const transport = build_private_tmpfile( `gh`, `hosts.yml`, `github.com:\n  oauth_token: fake-token\n` )

    return {
        transport,
        mount: {
            type: `copy`,
            source: transport.file,
            target: `/tmp/.babysit-gh-hosts.yml`,
            cleanup: transport.directory,
        },
    }

}

const fake_signals = () => new EventEmitter()

describe( `prepared Docker launch`, () => {

    it( `uploads credentials before cleanup without exposing tokens in create metadata`, async () => {

        const { transport, mount } = private_transport()
        const calls = []
        const signals = fake_signals()
        let uploaded_profile = null

        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )

                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `cp` ) ) {
                    expect( existsSync( transport.file ) ).toBe( true )
                    uploaded_profile = readFileSync( transport.file, `utf-8` )
                    return ``
                }

                throw new Error( `Unexpected Docker command: ${ args.join( ` ` ) }` )
            },
        } )

        const create_call = calls.find( call => call.args.includes( `create` ) )
        const copy_call = calls.find( call => call.args.includes( `cp` ) )

        expect( create_call.command ).toBe( `docker` )
        expect( create_call.args ).not.toContain( `run` )
        expect( create_call.args.join( ` ` ) ).not.toContain( `fake-token` )
        expect( create_call.args.join( ` ` ) ).not.toContain( transport.file )
        expect( copy_call.args ).toContain( transport.file )
        expect( copy_call.args ).toContain( `${ CONTAINER_ID }:/tmp/.babysit-gh-hosts.yml` )
        expect( uploaded_profile ).toContain( `fake-token` )
        expect( existsSync( transport.directory ) ).toBe( false )
        expect( launch.command ).toBe( `docker start -ai ${ CONTAINER_ID }` )

        launch.handoff()
        expect( signals.listenerCount( `SIGINT` ) ).toBe( 0 )

    } )

    it( `cleans the transport and stopped container when upload fails`, async () => {

        const { transport, mount } = private_transport()
        const calls = []

        await expect( prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `cp` ) ) throw new Error( `upload failed` )
                if( args.includes( `rm` ) ) return ``
                throw new Error( `Unexpected Docker command` )
            },
        } ) ).rejects.toThrow( `upload failed` )

        expect( existsSync( transport.directory ) ).toBe( false )
        expect( calls.some( call => call.args.includes( `start` ) ) ).toBe( false )
        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )

    } )

    it( `cleans the transport when Docker argument construction fails`, async () => {

        const { transport, mount } = private_transport()
        const options = make_options( mount )
        options.agent = null

        await expect( prepare_docker_launch( options, {
            signal_target: fake_signals(),
        } ) ).rejects.toThrow()

        expect( existsSync( transport.directory ) ).toBe( false )

    } )

    it( `can abort a copied container before tmux accepts the handoff`, async () => {

        const { mount } = private_transport()
        const calls = []
        const signals = fake_signals()

        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                return ``
            },
        } )

        await launch.abort()

        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )
        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 0 )

    } )

    it( `rejects malformed container ids and cleans by generated name`, async () => {

        const { transport, mount } = private_transport()
        const calls = []

        await expect( prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return `not-a-container-id`
                if( args.includes( `rm` ) ) return ``
                throw new Error( `Unexpected Docker command` )
            },
        } ) ).rejects.toThrow( `invalid container id` )

        const cleanup_call = calls.find( call => call.args.includes( `rm` ) )

        expect( cleanup_call.args.at( -1 ).startsWith( `babysit-opencode-` ) ).toBe( true )
        expect( existsSync( transport.directory ) ).toBe( false )

    } )

    it( `removes a prepared container when launch is interrupted before handoff`, async () => {

        const { mount } = private_transport()
        const signals = fake_signals()
        const synchronous_calls = []
        const kill_calls = []

        await prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            kill_process: ( pid, signal ) => kill_calls.push( { pid, signal } ),
            spawn_sync: ( command, args ) => {
                synchronous_calls.push( { command, args: [ ...args ] } )
                return { status: 0 }
            },
            run_command: async ( command, args ) => args.includes( `create` ) ? CONTAINER_ID : ``,
        } )

        signals.emit( `SIGTERM` )

        expect( synchronous_calls ).toEqual( [ {
            command: `docker`,
            args: [ `rm`, `-f`, CONTAINER_ID ],
        } ] )
        expect( kill_calls ).toEqual( [ { pid: process.pid, signal: `SIGTERM` } ] )
        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 0 )

    } )

} )
