import { spawnSync } from 'child_process'

import { cleanup_ephemeral_credential_mounts } from '../credentials/index.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import {
    build_docker_command,
    build_docker_command_args,
    docker_command_prefix,
    shell_quote,
} from './run.js'

const DOCKER_CREATE_TIMEOUT_MS = 5 * 60 * 1_000
const DOCKER_COPY_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/
const LAUNCH_SIGNALS = [ `SIGHUP`, `SIGINT`, `SIGTERM` ]

const copy_mounts_from = ( mounts = [] ) => mounts.filter( mount => mount.type === `copy` )

const container_name_from = ( args = [] ) => {

    const name_index = args.indexOf( `--name` )
    return name_index === -1 ? null : args[ name_index + 1 ] || null

}

const docker_action_args = ( args, action, prefix = docker_command_prefix() ) => {

    const action_index = prefix.length
    if( args[ action_index ] !== `run` ) {
        throw new Error( `Expected Docker run command before preparing staged credentials` )
    }

    const next_args = [ ...args ]
    next_args[ action_index ] = action

    return next_args

}

const render_command = args => args.map( shell_quote ).join( ` ` )

const remove_signal_handlers = ( signal_target, handlers ) => {

    for( const [ signal, handler ] of handlers ) {
        signal_target.removeListener( signal, handler )
    }

    handlers.clear()

}

/**
 * Build a launch command, uploading private credential files to a stopped
 * container when required. `docker cp` is the acknowledgment boundary: only
 * after the daemon accepts every file do we remove the host transport and let
 * tmux start the container.
 * @param {Object} options - Options accepted by build_docker_command_args
 * @param {Object} [dependencies] - Injectable process seams for tests
 * @returns {Promise<{command: string, container_id: string|null, abort: Function, handoff: Function}>}
 */
export const prepare_docker_launch = async ( options, {
    run_command = run,
    spawn_sync = spawnSync,
    cleanup_credentials = cleanup_ephemeral_credential_mounts,
    signal_target = process,
    kill_process = process.kill.bind( process ),
} = {} ) => {

    const copy_mounts = copy_mounts_from( options.creds_mounts )
    if( !copy_mounts.length ) {
        return {
            command: build_docker_command( options ),
            container_id: null,
            abort: async () => {},
            handoff: () => {},
        }
    }

    const prefix = docker_command_prefix()
    const [ docker_command, ...docker_prefix_args ] = prefix
    const signal_handlers = new Map()
    let container_name = null
    let container_id = null

    const container_reference = () => container_id || container_name

    const discard_container = async () => {
        const reference = container_reference()
        if( !reference ) return

        try {
            await run_command(
                docker_command,
                [ ...docker_prefix_args, `rm`, `-f`, reference ],
                {},
                DOCKER_CLEANUP_TIMEOUT_MS
            )
        } catch ( e ) {
            log.warn( `Failed to remove prepared Docker container ${ reference }: ${ e.message }` )
        }
    }

    const discard_container_sync = () => {
        const reference = container_reference()
        if( !reference ) return

        const result = spawn_sync(
            docker_command,
            [ ...docker_prefix_args, `rm`, `-f`, reference ],
            { stdio: `ignore`, timeout: DOCKER_CLEANUP_TIMEOUT_MS }
        )

        if( result.error || result.status !== 0 ) {
            log.warn( `Failed to remove interrupted Docker container ${ reference }` )
        }
    }

    const abort = async () => {
        remove_signal_handlers( signal_target, signal_handlers )
        cleanup_credentials( copy_mounts )
        await discard_container()
    }

    const handoff = () => remove_signal_handlers( signal_target, signal_handlers )

    for( const signal of LAUNCH_SIGNALS ) {
        const handler = () => {
            cleanup_credentials( copy_mounts )
            discard_container_sync()
            remove_signal_handlers( signal_target, signal_handlers )
            kill_process( process.pid, signal )
        }

        signal_handlers.set( signal, handler )
        signal_target.once( signal, handler )
    }

    try {
        const run_args = build_docker_command_args( options )
        const create_args = docker_action_args( run_args, `create`, prefix )
        container_name = container_name_from( create_args )

        const output = await run_command(
            docker_command,
            create_args.slice( 1 ),
            {},
            DOCKER_CREATE_TIMEOUT_MS
        )

        const created_container_id = String( output ).trim()
        if( !DOCKER_CONTAINER_ID_PATTERN.test( created_container_id ) ) {
            throw new Error( `Docker create returned an invalid container id` )
        }
        container_id = created_container_id

        for( const mount of copy_mounts ) {
            await run_command(
                docker_command,
                [ ...docker_prefix_args, `cp`, mount.source, `${ container_id }:${ mount.target }` ],
                {},
                DOCKER_COPY_TIMEOUT_MS
            )
        }

        if( !cleanup_credentials( copy_mounts ) ) {
            throw new Error( `Could not remove the private GitHub credential transport` )
        }

        return {
            command: render_command( [ ...prefix, `start`, `-ai`, container_id ] ),
            container_id,
            abort,
            handoff,
        }
    } catch ( e ) {
        await abort()
        throw e
    }

}
