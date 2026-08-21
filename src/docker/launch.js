import { statSync } from 'fs'
import { tmpdir } from 'os'
import { resolve, sep } from 'path'

import { cleanup_ephemeral_credential_mounts } from '../credentials/index.js'
import {
    clear_credential_recovery,
    register_credential_recovery,
} from '../credentials/recovery.js'
import { get_extra_mounts } from '../agents/setup.js'
import { build_private_tmpfile, private_credential_tmpdir } from '../utils/tmpfile.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { normalise_local_sync_file } from './file_transport.js'
import {
    build_docker_command_args,
    docker_command_prefix,
    shell_quote,
} from './run.js'
import { create_chrome_seccomp_profile } from './chrome-seccomp.js'

const DOCKER_CREATE_TIMEOUT_MS = 5 * 60 * 1_000
const DOCKER_COPY_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_INSPECT_TIMEOUT_MS = 15_000
const DOCKER_START_TIMEOUT_MS = 60_000
const DOCKER_START_POLL_MS = 100
const DOCKER_CONTAINER_ID_PATTERN = /^[0-9a-f]{12,64}$/
const LAUNCH_SIGNALS = [ `SIGHUP`, `SIGINT`, `SIGTERM` ]
const SECRET_ENV_BOOTSTRAP_PATH = `/tmp/.babysit-credentials.env`
const NON_SECRET_CREDENTIAL_ENV = new Set( [ `GH_CONFIG_DIR`, `GH_HOST` ] )

const copy_mounts_from = ( extra_mounts = [], credential_mounts = [] ) => [
    ...extra_mounts.filter( mount => mount.type === `copy` || mount.type === `seed_file` ),
    ...credential_mounts.filter( mount => mount.type === `copy` || mount.type === `synced_file` ),
]

const container_name_from = ( args = [] ) => {

    const name_index = args.indexOf( `--name` )
    return name_index === -1 ? null : args[ name_index + 1 ] || null

}

const docker_action_args = ( args, action, prefix = docker_command_prefix() ) => {

    const action_index = prefix.length
    if( args[ action_index ] !== `run` ) {
        throw new Error( `Expected Docker run command before preparing the launch` )
    }

    const next_args = [ ...args ]
    next_args[ action_index ] = action
    if( action === `create` && next_args[ action_index + 1 ] === `--rm` ) {
        next_args.splice( action_index + 1, 1 )
    }

    return next_args

}

const render_command = args => args.map( shell_quote ).join( ` ` )

const remove_signal_handlers = ( signal_target, handlers ) => {

    for( const [ signal, handler ] of handlers ) {
        signal_target.removeListener( signal, handler )
    }

    handlers.clear()

}

const is_ephemeral_path = path => {

    const temporary_root = `${ resolve( tmpdir() ) }${ sep }`
    return resolve( path ).startsWith( temporary_root )

}

const copy_source_from = path => {

    try {
        return statSync( path ).isDirectory() ? `${ path.replace( /\/$/, `` ) }/.` : path
    } catch {
        return path
    }

}

const build_secret_env_copy = ( mounts, build_private_file ) => {

    if( !mounts.length ) return null

    const lines = mounts.map( mount => {
        const value = String( mount.value )
        if( value.includes( `\n` ) || value.includes( `\0` ) ) {
            throw new Error( `Credential environment value for ${ mount.key } contains an unsupported newline or NUL` )
        }

        return `${ mount.key }=${ value }`
    } )
    const transport = build_private_file( `credentials`, `env`, `${ lines.join( `\n` ) }\n` )
    if( !transport ) throw new Error( `Could not build the private credential environment transport` )

    return {
        type: `copy`,
        source: transport.file,
        target: SECRET_ENV_BOOTSTRAP_PATH,
        cleanup: transport.directory,
    }

}

/**
 * Resolve generated agent config and credential descriptors exactly once.
 * Isolated config is copied into the stopped container, while secrets become
 * either copied files or a private environment bootstrap consumed at entry.
 *
 * @param {Object} options - Raw Docker launch options
 * @param {Function} [build_private_file=build_private_tmpfile] - Private file builder
 * @returns {Object} Launch options with a precomputed typed mount plan
 */
export const build_docker_launch_plan = ( options, {
    build_private_file = build_private_tmpfile,
} = {} ) => {

    const mode = options.mode || {}
    const include_host_agent_context = options.include_host_agent_context ?? !mode.ignore_host_agents_md
    const generated_extra_mounts = options.extra_mounts || get_extra_mounts( options.agent.name )( {
        yolo: mode.yolo,
        include_host_preferences: include_host_agent_context,
        auth_probe: options.auth_probe === true,
        workspace: options.workspace,
    } )
    const raw_credential_mounts = options.creds_mounts || []
    const has_staged_agent_credentials = raw_credential_mounts.some( mount => mount.type === `synced_file` )

    const extra_mounts = generated_extra_mounts.map( mount => {
        const should_stage = mode.ignore_host_agents_md
            ? true
            : has_staged_agent_credentials && is_ephemeral_path( mount.host )

        if( !should_stage ) return mount

        return {
            ...mount,
            type: `seed_file`,
            source: copy_source_from( mount.host ),
            target: mount.container,
            cleanup: mount.cleanup || ( is_ephemeral_path( mount.host ) ? mount.host : null ),
        }
    } )

    const is_secret_environment = mount => {
        if( mount.type === `secret_env` ) return true
        return mount.type === `env` && !NON_SECRET_CREDENTIAL_ENV.has( mount.key )
    }

    const secret_env_mounts = mode.ignore_host_agents_md
        ? raw_credential_mounts.filter( is_secret_environment )
        : raw_credential_mounts.filter( mount => mount.type === `secret_env` )
    const secret_env_set = new Set( secret_env_mounts )
    const creds_mounts = raw_credential_mounts.filter( mount => !secret_env_set.has( mount ) )
    let secret_env_copy
    try {
        secret_env_copy = build_secret_env_copy( secret_env_mounts, build_private_file )
    } catch ( error ) {
        cleanup_ephemeral_credential_mounts( [ ...extra_mounts, ...raw_credential_mounts ] )
        throw error
    }

    if( secret_env_copy ) creds_mounts.push( secret_env_copy )

    return {
        ...options,
        extra_mounts,
        creds_mounts,
    }

}

const wait = ms => new Promise( resolve_wait => setTimeout( resolve_wait, ms ) )

/**
 * Build a launch command through a stopped container. `docker create` is the
 * acknowledgment boundary for the seccomp profile; any private files are then
 * uploaded before short-lived host transports are removed.
 *
 * @param {Object} options - Options accepted by build_docker_command_args
 * @param {Object} [dependencies] - Injectable process seams for tests
 * @param {AbortSignal|null} [dependencies.signal] - External preparation cancellation
 * @returns {Promise<{
 *   command: string,
 *   command_args: string[],
 *   container_id: string|null,
 *   abort: Function,
 *   await_started: Function,
 *   pull_synced_files: Function,
 *   retain: Function,
 *   handoff: Function
 * }>} Prepared launch controller
 */
export const prepare_docker_launch = async ( options, {
    run_command = run,
    cleanup_credentials = cleanup_ephemeral_credential_mounts,
    clear_recovery = clear_credential_recovery,
    register_recovery = register_credential_recovery,
    signal_target = process,
    kill_process = process.kill.bind( process ),
    build_private_file = build_private_tmpfile,
    create_seccomp_profile = create_chrome_seccomp_profile,
    signal = null,
} = {} ) => {

    let planned_options
    let seccomp_transport
    try {
        planned_options = build_docker_launch_plan( options, { build_private_file } )
        seccomp_transport = create_seccomp_profile()
        planned_options = {
            ...planned_options,
            chrome_seccomp_profile_path: seccomp_transport.file,
        }
    } catch ( error ) {
        const cleanup_mounts = planned_options
            ? [ ...planned_options.extra_mounts, ...planned_options.creds_mounts ]
            : options.creds_mounts || []
        cleanup_credentials( cleanup_mounts )
        throw error
    }

    const seccomp_cleanup = [ { cleanup: seccomp_transport.directory } ]
    let seccomp_profile_cleaned = false
    const cleanup_seccomp_profile = () => {
        if( seccomp_profile_cleaned ) return true

        seccomp_profile_cleaned = cleanup_credentials( seccomp_cleanup )
        return seccomp_profile_cleaned
    }

    const copy_mounts = copy_mounts_from( planned_options.extra_mounts, planned_options.creds_mounts )
    const prefix = docker_command_prefix()
    const [ docker_command, ...docker_prefix_args ] = prefix
    const signal_handlers = new Map()
    const abort_controller = new AbortController()
    const abort_preparation = () => abort_controller.abort( signal?.reason )
    let active_command = null
    let container_name = null
    let container_id = null
    let container_owned = false
    let create_started = false
    let interrupted = false
    let handed_off = false
    let staging_complete = false
    let abort_task = null
    let recovery_id = null

    signal?.addEventListener?.( `abort`, abort_preparation, { once: true } )
    if( signal?.aborted ) abort_preparation()

    const remove_external_abort_handler = () =>
        signal?.removeEventListener?.( `abort`, abort_preparation )

    const synced_files = planned_options.creds_mounts.filter( mount => mount.type === `synced_file` )
    const recoverable_sync_paths = synced_files.map(
        mount => private_credential_tmpdir( mount.source ) || mount.source
    )

    const run_docker = async ( args, timeout_ms ) => {
        const task = Promise.resolve( run_command(
            docker_command,
            args,
            {
                signal: abort_controller.signal,
                detached: process.platform !== `win32`,
            },
            timeout_ms
        ) )
        active_command = task

        try {
            return await task
        } finally {
            if( active_command === task ) active_command = null
        }
    }

    const container_reference = ( { include_attempted_name = false } = {} ) => {
        if( container_id ) return container_id
        if( container_owned || include_attempted_name ) return container_name
        return null
    }

    const discard_container = async ( options = {} ) => {
        const reference = container_reference( options )
        if( !reference ) return true

        try {
            await run_command(
                docker_command,
                [ ...docker_prefix_args, `rm`, `-f`, reference ],
                {},
                DOCKER_CLEANUP_TIMEOUT_MS
            )
            return true
        } catch ( error ) {
            log.warn( `Failed to remove prepared Docker container ${ reference }: ${ error.message }` )
            return false
        }
    }

    const retain = async ( { stop = false } = {} ) => {
        const reference = container_reference()

        handed_off = true
        remove_signal_handlers( signal_target, signal_handlers )
        remove_external_abort_handler()
        cleanup_seccomp_profile()

        if( stop && reference ) {
            try {
                await run_command(
                    docker_command,
                    [ ...docker_prefix_args, `stop`, `--time`, `5`, reference ],
                    {},
                    DOCKER_CLEANUP_TIMEOUT_MS
                )
            } catch ( error ) {
                log.warn( `Failed to stop retained Docker container ${ reference }: ${ error.message }` )
            }
        }

        return reference
    }

    const abort = async ( { include_attempted_name = false } = {} ) => {
        if( handed_off ) return
        if( abort_task ) return abort_task

        abort_task = ( async () => {
            abort_controller.abort()
            if( active_command ) await active_command.catch( () => {} )

            remove_signal_handlers( signal_target, signal_handlers )
            remove_external_abort_handler()
            cleanup_credentials( copy_mounts )
            cleanup_seccomp_profile()
            const discarded = await discard_container( { include_attempted_name } )
            if( discarded ) clear_recovery( recovery_id )
        } )()

        return abort_task
    }

    const handoff = () => {
        handed_off = true
        remove_signal_handlers( signal_target, signal_handlers )
        remove_external_abort_handler()
        clear_recovery( recovery_id )
        cleanup_seccomp_profile()
    }

    for( const signal of LAUNCH_SIGNALS ) {
        const handler = () => {
            if( interrupted ) return
            interrupted = true

            void ( async () => {
                // Once staging is complete, the container may have started and
                // rotated a credential before this process sees the signal.
                // Stop and retain it for recovery instead of deleting the only
                // potentially valid copy. Earlier create/copy interruptions are
                // safe to abort because agent code has not run yet.
                if( staging_complete && synced_files.length ) {
                    const retained_container = await retain( { stop: true } )
                    log.warn(
                        `Launch interrupted after credential staging; retained Docker container ${ retained_container } and private sync files for recovery.`
                    )
                } else {
                    await abort( { include_attempted_name: create_started } )
                }
                kill_process( process.pid, signal )
            } )()
        }

        signal_handlers.set( signal, handler )
        signal_target.once( signal, handler )
    }

    try {
        if( signal?.aborted ) throw new Error( `Docker launch preparation cancelled` )

        const run_args = build_docker_command_args( planned_options )
        const create_args = docker_action_args( run_args, `create`, prefix )
        container_name = container_name_from( create_args )
        create_started = true

        const output = await run_docker( create_args.slice( 1 ), DOCKER_CREATE_TIMEOUT_MS )
        container_owned = true
        if( !cleanup_seccomp_profile() ) {
            throw new Error( `Could not remove Chrome's private seccomp profile after Docker create` )
        }

        const created_container_id = String( output ).trim()
        if( !DOCKER_CONTAINER_ID_PATTERN.test( created_container_id ) ) {
            throw new Error( `Docker create returned an invalid container id` )
        }
        container_id = created_container_id

        for( const mount of copy_mounts ) {
            await run_docker(
                [ ...docker_prefix_args, `cp`, mount.source, `${ container_id }:${ mount.target }` ],
                DOCKER_COPY_TIMEOUT_MS
            )
        }

        if( !cleanup_credentials( copy_mounts ) ) {
            throw new Error( `Could not remove a private launch transport` )
        }

        recovery_id = register_recovery( {
            container_id,
            sync_paths: recoverable_sync_paths,
        } )
        staging_complete = true

        const command_args = [ ...prefix, `start`, `-ai`, container_id ]

        const pull_synced_files = async ( { target = null } = {} ) => {
            const selected_synced_files = synced_files
                .filter( mount => !target || mount.target === target )

            // Pull sequentially so active_command always identifies the one
            // Docker client that abort() must await before cleanup.
            for( const mount of selected_synced_files ) {
                await run_docker(
                    [ ...docker_prefix_args, `cp`, `${ container_id }:${ mount.target }`, mount.source ],
                    DOCKER_COPY_TIMEOUT_MS
                )
                await normalise_local_sync_file( mount.source, { run_command } )
            }
        }

        const await_started = async ( {
            timeout_ms = DOCKER_START_TIMEOUT_MS,
            poll_ms = DOCKER_START_POLL_MS,
        } = {} ) => {
            if( handed_off ) return true

            const deadline = Date.now() + timeout_ms
            while( Date.now() < deadline ) {
                let status

                try {
                    status = await run_docker( [
                        ...docker_prefix_args,
                        `inspect`,
                        `--format`,
                        `{{.State.Status}}`,
                        container_id,
                    ], DOCKER_INSPECT_TIMEOUT_MS )
                } catch ( error ) {
                    if( error.code !== `ETIMEDOUT` ) return false

                    // Docker Desktop and loaded remote daemons can miss one
                    // inspect deadline while the already-started container is
                    // healthy. Retry until the overall startup deadline. Hard
                    // Docker errors still fail immediately.
                    await wait( poll_ms )
                    continue
                }

                if( [ `running`, `paused`, `restarting` ].includes( status ) ) return true
                if( [ `exited`, `dead`, `removing` ].includes( status ) ) return false

                await wait( poll_ms )
            }

            return false
        }

        if( signal?.aborted ) throw new Error( `Docker launch preparation cancelled` )
        remove_external_abort_handler()

        return {
            command: render_command( command_args ),
            command_args,
            container_id,
            abort,
            await_started,
            pull_synced_files,
            retain,
            handoff,
        }
    } catch ( error ) {
        const create_may_have_completed = create_started
            && ( interrupted || abort_controller.signal.aborted || error.code === `ETIMEDOUT` )

        await abort( { include_attempted_name: create_may_have_completed } )
        throw error
    }

}
