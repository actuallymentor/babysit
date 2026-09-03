import { existsSync } from 'fs'

import { log } from '../utils/log.js'
import { load_session, session_workspace, update_session } from '../sessions/store.js'
import { load_config } from '../babysit/yaml.js'
import { get_agent } from '../agents/index.js'
import { get_patterns } from '../patterns/index.js'
import { apply_loop } from '../modes/loop.js'
import { build_system_prompt } from '../modes/prompt.js'
import { setup_credentials } from '../credentials/index.js'
import { start_monitor } from '../babysit/monitor.js'
import { start_caffeinate, stop_caffeinate } from '../utils/caffeinate.js'
import { remove_docker_container, wait_for_docker_container_stopped } from '../docker/file_transport.js'
import {
    clear_host_auth_cache,
    refresh_file_credential_parts,
    refresh_host_auth_cache,
} from '../agents/auth_cache.js'

const log_shutdown_timing = message => process.env.BABYSIT_DEBUG === `1`
    ? log.info( message )
    : log.debug( message )

/**
 * Rebuild the launch mode from stored session modifiers.
 * @param {string[]} modifiers - Stored session modifiers
 * @returns {Object} Mode descriptor for prompt construction
 */
export const mode_from_modifiers = ( modifiers = [] ) => ( {
    yolo: modifiers.includes( `yolo` ),
    sandbox: modifiers.includes( `sandbox` ),
    mudbox: modifiers.includes( `mudbox` ),
    docker: modifiers.includes( `docker` ),
    clone: modifiers.includes( `clone` ),
    ignore_host_agents_md: modifiers.includes( `ignore-host-agents-md` ),
} )

/**
 * Load babysit config for a detached monitor using the original launch mode.
 * @param {Object} session - Stored session metadata
 * @returns {{ config: Object, rules: Array }} Parsed config and rules
 */
export const load_monitor_config = ( session = {} ) => load_config( session_workspace( session ), {
    default_initial_prompt: build_system_prompt( mode_from_modifiers( session.modifiers ) ),
} )

/**
 * Preserve a fresh auth result across a token rotation performed by the
 * already-trusted session. A deliberate host credential replacement clears
 * trust instead, and compare-and-swap protects concurrent launches.
 *
 * @param {Object} session - Stored session metadata
 * @param {Object} agent - Active agent adapter, used for legacy session metadata
 * @param {Object} creds_sync - Completed credential sync controller
 * @param {Object} tmpfiles - Per-agent staged credential files
 * @param {Object} [dependencies] - Cache test seams
 * @returns {boolean} Whether cache trust was refreshed
 */
export const refresh_session_auth_cache = ( session, agent, creds_sync, tmpfiles, {
    clear_cache = clear_host_auth_cache,
    refresh_parts = refresh_file_credential_parts,
    refresh_cache = refresh_host_auth_cache,
} = {} ) => {

    const contexts = session.auth_cache_contexts || (
        session.auth_cache_context ? { [ agent.name ]: session.auth_cache_context } : {}
    )
    if( !Object.keys( contexts ).length ) return false

    try {
        const refreshed = Object.entries( contexts ).map( ( [ name, context ] ) => {
            if( creds_sync.source_changed?.( name ) ) {
                clear_cache( name, {
                    expected_credential_fingerprint: context.credential_fingerprint,
                    image_identity: context.image_identity,
                } )
                return false
            }

            const refreshed_identity = refresh_parts(
                context.credential_parts,
                tmpfiles[ name ]
            )
            if( !refreshed_identity ) return false

            return refresh_cache( name, {
                expected_credential_fingerprint: context.credential_fingerprint,
                next_credential_fingerprint: refreshed_identity.fingerprint,
                image_identity: context.image_identity,
            } )
        } )

        return refreshed.every( Boolean )
    } catch ( error ) {
        // Cache metadata is an optimization. Credential recovery already
        // succeeded, so a cache write failure must not retain the container.
        log.debug( `Could not refresh session authentication caches: ${ error.message }` )
        return false
    }

}

/**
 * Run the supervision loop for an already-launched session.
 *
 * Internal subcommand (`babysit __monitor <id>`) — `cmd_start` spawns this
 * detached so the monitor can outlive the foreground process. Without the
 * detach, the monitor would die the moment the user detaches from tmux,
 * leaving the agent unsupervised and tokens un-refreshed.
 *
 * @param {Object} cmd - Parsed command { session_id }
 * @returns {Promise<void>}
 */
export const cmd_monitor = async ( cmd ) => {

    const { session_id } = cmd

    if( !session_id ) {
        log.error( `Internal: __monitor requires a session id` )
        process.exit( 1 )
    }

    const session = load_session( session_id )
    if( !session ) {
        log.error( `Internal: session not found for ${ session_id }` )
        process.exit( 1 )
    }

    if( session.monitor_token && cmd.monitor_token !== session.monitor_token ) {
        log.error( `Internal: monitor token mismatch for ${ session_id }` )
        process.exit( 1 )
    }

    // Restore the original working directory so cwd-relative paths in
    // babysit.yaml (./IDLE.md, ./LOOP.md) resolve the same way the
    // foreground saw them when it parsed the rules.
    const workspace = session_workspace( session )
    if( workspace && existsSync( workspace ) ) {
        try {
            process.chdir( workspace )
        } catch ( e ) {
            log.warn( `Could not chdir to ${ workspace }: ${ e.message }` )
        }
    }

    update_session( session.babysit_id, {
        monitor_pid: process.pid,
        monitor_started_at: new Date().toISOString(),
        status: `active`,
    } )

    const agent = get_agent( session.agent )
    const existing_tmpfiles = session.creds_tmpfiles || (
        session.creds_tmpfile ? { [ session.agent ]: session.creds_tmpfile } : {}
    )
    const sync_baselines = session.creds_sync_baselines || (
        session.creds_sync_baseline ? { [ session.agent ]: session.creds_sync_baseline } : {}
    )

    let creds_sync = null
    let credential_setup_complete = false
    let caffeinate = null
    let container_cleaned = false
    let credentials_cleaned = false
    let credential_cleanup_task = null
    let credential_cleanup_result = null
    let container_cleanup_task = null
    let container_cleanup_result = null
    let container_stop_task = null

    const wait_for_container_stop = () => {
        if( !session.container_id ) return Promise.resolve( null )
        if( container_stop_task ) return container_stop_task

        const started_at = Date.now()
        container_stop_task = wait_for_docker_container_stopped( session.container_id )
            .then( status => {
                log_shutdown_timing( `Shutdown: Docker reached ${ status } in ${ Date.now() - started_at }ms` )
                return status
            } )

        return container_stop_task
    }

    const cleanup_credentials = async () => {
        if( credential_cleanup_result !== null ) return credential_cleanup_result
        if( credentials_cleaned ) return true
        if( !credential_setup_complete ) {
            const has_recovery_files = Object.keys( existing_tmpfiles ).length > 0
            if( has_recovery_files ) {
                log.warn( `Credential recovery could not start; retaining container and private recovery files.` )
                credential_cleanup_result = false
                return false
            }

            credential_cleanup_result = true
            return true
        }
        if( !creds_sync ) {
            credential_cleanup_result = true
            return true
        }
        if( credential_cleanup_task ) return credential_cleanup_task

        credential_cleanup_task = ( async () => {
            const started_at = Date.now()
            try {
                await wait_for_container_stop()
                await creds_sync.stop()
                refresh_session_auth_cache( session, agent, creds_sync, existing_tmpfiles )
                if( !creds_sync.cleanup() ) {
                    log.warn( `Could not remove private credential recovery files; retaining the stopped container for retry.` )
                    credential_cleanup_result = false
                    return false
                }
                credentials_cleaned = true
                credential_cleanup_result = true
                log_shutdown_timing( `Shutdown: credential finalisation completed in ${ Date.now() - started_at }ms` )
                return true
            } catch ( error ) {
                log.warn(
                    `Could not flush completed session credentials; retaining container and private recovery files: ${ error.message }`
                )
                credential_cleanup_result = false
                return false
            }
        } )()

        return credential_cleanup_task
    }

    const cleanup_container = async () => {
        if( container_cleanup_result !== null ) return container_cleanup_result
        if( container_cleaned || !session.container_id ) {
            container_cleanup_result = true
            return true
        }
        if( container_cleanup_task ) return container_cleanup_task

        container_cleanup_task = ( async () => {
            const started_at = Date.now()
            try {
                await wait_for_container_stop()
                await remove_docker_container( session.container_id )
                container_cleaned = true
                container_cleanup_result = true
                log_shutdown_timing( `Shutdown: container removal completed in ${ Date.now() - started_at }ms` )
                return true
            } catch ( error ) {
                container_cleanup_result = false
                log.debug( `Could not remove completed Docker container ${ session.container_id }: ${ error.message }` )
                return false
            }
        } )()

        return container_cleanup_task
    }

    try {

        // Set up our own credential sync before loading monitor configuration.
        // If config parsing then fails, the outer teardown can still perform a
        // final Docker pull instead of deleting the only refreshed copy.
        const credential_setup = await setup_credentials( agent, {
            existing_tmpfiles,
            sync_baselines,
        } )
        creds_sync = credential_setup.sync
        credential_setup_complete = true
        if( creds_sync && session.container_id ) creds_sync.connect( session.container_id )

        const { config, rules } = load_monitor_config( session )

        // Re-apply --loop if it was active in the original session — the rule
        // override mutates `rules` in place, so the monitor sees the same
        // LOOP.md action as the foreground process.
        if( session.modifiers?.includes( `loop` ) ) {
            apply_loop( rules, workspace, {
                include_global_loop: !session.modifiers.includes( `ignore-host-agents-md` ),
            } )
        }

        const agent_patterns = get_patterns( session.agent )

        log.info( `Monitor watching session ${ session.babysit_id } (${ session.tmux_session })` )
        caffeinate = start_caffeinate()

        await start_monitor( {
            session_name: session.tmux_session,
            config,
            rules,
            agent_patterns,
            agent,
            agent_exit_sentinel: session.agent_exit_sentinel,
            on_session_id: ( id ) => {
                update_session( session.babysit_id, { agent_session_id: id } )
            },
            on_exit: async () => {
                // Await so the sync's final flush completes before the process
                // exits — otherwise a token refresh that happened in the last
                // REFRESH_INTERVAL_MS window never makes it back to the host file.
                if( await cleanup_credentials() ) await cleanup_container()
            },
        } )

    } finally {
        const credentials_recovered = await cleanup_credentials()
        const container_removed = credentials_recovered
            ? await cleanup_container()
            : false
        stop_caffeinate( caffeinate )

        // Do not clear a newer monitor spawned during recovery.
        const latest = load_session( session.babysit_id )
        if( latest?.monitor_pid === process.pid ) {
            update_session( session.babysit_id, {
                container_cleaned: container_removed,
                credentials_cleaned: credentials_recovered,
                monitor_pid: null,
                status: `exited`,
            } )
        }
    }

    log.info( `Monitor exited for session ${ session.babysit_id }` )

}
