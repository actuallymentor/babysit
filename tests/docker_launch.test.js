import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'events'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath } from 'url'

import { opencode } from '../src/agents/opencode.js'
import { build_docker_launch_plan, prepare_docker_launch } from '../src/docker/launch.js'
import { build_docker_command_args } from '../src/docker/run.js'
import { cleanup_ephemeral_credential_mounts } from '../src/credentials/index.js'
import { build_private_tmpfile } from '../src/utils/tmpfile.js'

const CONTAINER_ID = `a`.repeat( 64 )
const chrome_seccomp_profile_path = fileURLToPath(
    new URL( `../src/docker/chrome-seccomp.json`, import.meta.url )
)

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
    chrome_seccomp_profile_path,
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

    it( `keeps isolated generated config and credentials out of bind metadata`, () => {

        const config = build_private_tmpfile( `config`, `settings.json`, `{}` )
        const credential = build_private_tmpfile( `credential`, `auth.json`, `secret-file` )
        const options = make_options( {
            type: `synced_file`,
            source: credential.file,
            target: `/home/node/.local/share/opencode/auth.json`,
        } )
        options.extra_mounts = [ {
            host: config.file,
            container: `/home/node/.config/opencode/settings.json`,
        } ]
        options.creds_mounts.push( {
            type: `env`,
            key: `OPENCODE_API_KEY`,
            value: `secret-env`,
        } )

        const plan = build_docker_launch_plan( options )
        const args = build_docker_command_args( plan )

        try {
            expect( args.join( ` ` ) ).not.toContain( config.file )
            expect( args.join( ` ` ) ).not.toContain( credential.file )
            expect( args.join( ` ` ) ).not.toContain( `secret-env` )
            expect( plan.extra_mounts[0].type ).toBe( `seed_file` )
            expect( plan.creds_mounts ).toContainEqual( expect.objectContaining( {
                type: `synced_file`,
                source: credential.file,
            } ) )
            expect( plan.creds_mounts ).toContainEqual( expect.objectContaining( {
                type: `copy`,
                target: `/tmp/.babysit-credentials.env`,
            } ) )
        } finally {
            cleanup_ephemeral_credential_mounts( [ ...plan.extra_mounts, ...plan.creds_mounts ] )
            cleanup_ephemeral_credential_mounts( [
                { cleanup: config.directory },
                { cleanup: credential.directory },
            ] )
        }

    } )

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
        const security_option = create_call.args[ create_call.args.indexOf( `--security-opt` ) + 1 ]
        const seccomp_profile_path = security_option.replace( `seccomp=`, `` )

        expect( create_call.command ).toBe( `docker` )
        expect( create_call.args ).not.toContain( `run` )
        expect( create_call.args ).not.toContain( `--rm` )
        expect( create_call.args.join( ` ` ) ).not.toContain( `fake-token` )
        expect( create_call.args.join( ` ` ) ).not.toContain( transport.file )
        expect( copy_call.args ).toContain( transport.file )
        expect( copy_call.args ).toContain( `${ CONTAINER_ID }:/tmp/.babysit-gh-hosts.yml` )
        expect( uploaded_profile ).toContain( `fake-token` )
        expect( existsSync( transport.directory ) ).toBe( false )
        expect( seccomp_profile_path ).toStartWith( `/tmp/babysit-chrome-chrome-seccomp.json-` )
        expect( existsSync( seccomp_profile_path ) ).toBe( false )
        expect( launch.command ).toBe( `docker start -ai ${ CONTAINER_ID }` )

        launch.handoff()
        expect( signals.listenerCount( `SIGINT` ) ).toBe( 0 )

    } )

    it( `retains a direct-run seccomp profile only until launch handoff`, async () => {

        const options = make_options( {} )
        options.creds_mounts = []
        options.extra_mounts = []
        const seccomp_transport = build_private_tmpfile(
            `chrome-test`,
            `chrome-seccomp.json`,
            `{}`
        )

        const launch = await prepare_docker_launch( options, {
            create_seccomp_profile: () => seccomp_transport,
        } )

        expect( launch.command ).toContain( `seccomp=${ seccomp_transport.file }` )
        expect( existsSync( seccomp_transport.file ) ).toBe( true )

        launch.handoff()
        expect( existsSync( seccomp_transport.directory ) ).toBe( false )

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

    it( `does not remove an unowned name when docker create is rejected`, async () => {

        const { transport, mount } = private_transport()
        const calls = []

        await expect( prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) throw new Error( `name conflict` )
                return ``
            },
        } ) ).rejects.toThrow( `name conflict` )

        expect( calls.some( call => call.args.includes( `rm` ) ) ).toBe( false )
        expect( existsSync( transport.directory ) ).toBe( false )

    } )

    it( `removes a generated name when docker create times out`, async () => {

        const { transport, mount } = private_transport()
        const calls = []

        await expect( prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) {
                    const error = new Error( `docker timed out` )
                    error.code = `ETIMEDOUT`
                    throw error
                }
                return ``
            },
        } ) ).rejects.toThrow( `docker timed out` )

        const create_call = calls.find( call => call.args.includes( `create` ) )
        const name_index = create_call.args.indexOf( `--name` )
        const generated_name = create_call.args[ name_index + 1 ]

        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( generated_name ) ) ).toBe( true )
        expect( existsSync( transport.directory ) ).toBe( false )

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

    it( `removes a static-secret container when launch is interrupted before handoff`, async () => {

        const { mount } = private_transport()
        const signals = fake_signals()
        const calls = []
        const kill_calls = []

        await prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            kill_process: ( pid, signal ) => kill_calls.push( { pid, signal } ),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                return args.includes( `create` ) ? CONTAINER_ID : ``
            },
        } )

        signals.emit( `SIGTERM` )
        await new Promise( resolve => setTimeout( resolve, 0 ) )

        expect( calls.some( call => call.args.includes( `stop` ) ) ).toBe( false )
        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )
        expect( kill_calls ).toEqual( [ { pid: process.pid, signal: `SIGTERM` } ] )
        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 0 )

    } )

    it( `stops and durably retains a refreshable credential container on interruption`, async () => {

        const transport = build_private_tmpfile(
            `creds-opencode`,
            `auth.json`,
            `{"refresh_token":"rotated"}`,
            { file_mode: 0o666 }
        )
        const options = make_options( {
            type: `synced_file`,
            source: transport.file,
            target: opencode.container_paths.creds,
        } )
        const signals = fake_signals()
        const calls = []
        const recovery_records = []
        const cleared_recoveries = []
        const kill_calls = []

        try {
            await prepare_docker_launch( options, {
                clear_recovery: id => cleared_recoveries.push( id ),
                register_recovery: recovery => {
                    recovery_records.push( recovery )
                    return `recovery-id`
                },
                signal_target: signals,
                kill_process: ( pid, signal ) => kill_calls.push( { pid, signal } ),
                run_command: async ( command, args ) => {
                    calls.push( { command, args: [ ...args ] } )
                    return args.includes( `create` ) ? CONTAINER_ID : ``
                },
            } )

            signals.emit( `SIGTERM` )
            await new Promise( resolve => setTimeout( resolve, 0 ) )

            expect( recovery_records ).toEqual( [ {
                container_id: CONTAINER_ID,
                sync_paths: [ transport.directory ],
            } ] )
            expect( calls.filter( call => call.args.includes( `stop` ) ) ).toEqual( [ {
                command: `docker`,
                args: [ `stop`, `--time`, `5`, CONTAINER_ID ],
            } ] )
            expect( calls.some( call => call.args.includes( `rm` ) ) ).toBe( false )
            expect( cleared_recoveries ).toEqual( [] )
            expect( kill_calls ).toEqual( [ { pid: process.pid, signal: `SIGTERM` } ] )
        } finally {
            cleanup_ephemeral_credential_mounts( [ { cleanup: transport.directory } ] )
        }

    } )

    it( `cancels an in-flight copy before removing its source and container`, async () => {

        const { transport, mount } = private_transport()
        const signals = fake_signals()
        const calls = []
        const kill_calls = []
        let copy_started
        const copying = new Promise( resolve => {
            copy_started = resolve
        } )

        const launch_task = prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            kill_process: ( pid, signal ) => kill_calls.push( { pid, signal } ),
            run_command: async ( command, args, options ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `cp` ) ) {
                    copy_started()
                    return new Promise( ( resolve, reject ) => {
                        options.signal.addEventListener( `abort`, () => reject( new Error( `copy aborted` ) ) )
                    } )
                }
                return ``
            },
        } )

        await copying
        expect( existsSync( transport.file ) ).toBe( true )

        signals.emit( `SIGINT` )
        await expect( launch_task ).rejects.toThrow( `copy aborted` )
        await new Promise( resolve => setTimeout( resolve, 0 ) )

        expect( existsSync( transport.directory ) ).toBe( false )
        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )
        expect( kill_calls ).toEqual( [ { pid: process.pid, signal: `SIGINT` } ] )

    } )

    it( `honours an external cancellation before Docker create`, async () => {

        const { transport, mount } = private_transport()
        const controller = new AbortController()
        const calls = []

        controller.abort( { code: `skip` } )

        await expect( prepare_docker_launch( make_options( mount ), {
            signal: controller.signal,
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                return ``
            },
        } ) ).rejects.toThrow( `Docker launch preparation cancelled` )

        expect( calls ).toEqual( [] )
        expect( existsSync( transport.directory ) ).toBe( false )

    } )

    it( `uses external cancellation to stop an in-flight Docker copy`, async () => {

        const { transport, mount } = private_transport()
        const controller = new AbortController()
        const calls = []
        let copy_started
        const copying = new Promise( resolve => {
            copy_started = resolve
        } )

        const launch_task = prepare_docker_launch( make_options( mount ), {
            signal: controller.signal,
            signal_target: fake_signals(),
            run_command: async ( command, args, options ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `cp` ) ) {
                    copy_started()
                    return new Promise( ( resolve, reject ) => {
                        options.signal.addEventListener(
                            `abort`,
                            () => reject( new Error( `external copy cancellation` ) ),
                            { once: true }
                        )
                    } )
                }
                return ``
            },
        } )

        await copying
        controller.abort( { code: `skip` } )
        await expect( launch_task ).rejects.toThrow( `external copy cancellation` )

        expect( existsSync( transport.directory ) ).toBe( false )
        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )

    } )

    it( `keeps ownership until Docker acknowledges the started container`, async () => {

        const { mount } = private_transport()
        const signals = fake_signals()
        const statuses = [ `created`, `created`, `running` ]

        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: signals,
            run_command: async ( command, args ) => {
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `inspect` ) ) return statuses.shift()
                return ``
            },
        } )

        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 1 )
        expect( await launch.await_started( { timeout_ms: 1_000, poll_ms: 1 } ) ).toBe( true )
        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 1 )

        launch.handoff()
        expect( signals.listenerCount( `SIGTERM` ) ).toBe( 0 )

    } )

    it( `retries transient Docker inspection failures while startup remains bounded`, async () => {

        const { mount } = private_transport()
        let inspections = 0
        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `inspect` ) ) {
                    inspections += 1
                    if( inspections === 1 ) {
                        const error = new Error( `docker inspect timed out` )
                        error.code = `ETIMEDOUT`
                        throw error
                    }
                    return `running`
                }
                return ``
            },
        } )

        expect( await launch.await_started( { timeout_ms: 1_000, poll_ms: 1 } ) ).toBe( true )
        expect( inspections ).toBe( 2 )
        await launch.abort()

    } )

    it( `fails immediately on hard Docker inspection errors`, async () => {

        const { mount } = private_transport()
        let inspections = 0
        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `inspect` ) ) {
                    inspections += 1
                    throw new Error( `No such container` )
                }
                return ``
            },
        } )

        expect( await launch.await_started( { timeout_ms: 1_000, poll_ms: 1 } ) ).toBe( false )
        expect( inspections ).toBe( 1 )
        await launch.abort()

    } )

    it( `removes a container that never leaves the created state`, async () => {

        const { mount } = private_transport()
        const calls = []
        const launch = await prepare_docker_launch( make_options( mount ), {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `inspect` ) ) return `created`
                return ``
            },
        } )

        expect( await launch.await_started( { timeout_ms: 2, poll_ms: 1 } ) ).toBe( false )
        await launch.abort()

        expect( calls.some( call => call.args.includes( `rm` ) && call.args.includes( CONTAINER_ID ) ) ).toBe( true )

    } )

    it( `stages isolated secret environment values outside Docker metadata`, async () => {

        const options = make_options( {
            type: `secret_env`,
            key: `GH_TOKEN`,
            value: `private-token`,
        } )
        options.creds_mounts = [ options.creds_mounts[0] ]

        let staged_environment = ``
        const calls = []
        const launch = await prepare_docker_launch( options, {
            signal_target: fake_signals(),
            run_command: async ( command, args ) => {
                calls.push( { command, args: [ ...args ] } )
                if( args.includes( `create` ) ) return CONTAINER_ID
                if( args.includes( `cp` ) ) {
                    staged_environment = readFileSync( args.at( -2 ), `utf-8` )
                    return ``
                }
                return ``
            },
        } )

        const create_args = calls.find( call => call.args.includes( `create` ) ).args

        expect( create_args.join( ` ` ) ).not.toContain( `private-token` )
        expect( staged_environment ).toBe( `GH_TOKEN=private-token\n` )

        await launch.abort()

    } )

} )
