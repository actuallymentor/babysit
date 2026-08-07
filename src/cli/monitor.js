import { existsSync } from 'fs'

import { log } from '../utils/log.js'
import { load_session, update_session } from '../sessions/store.js'
import { load_config } from '../babysit/yaml.js'
import { get_agent } from '../agents/index.js'
import { get_patterns } from '../patterns/index.js'
import { apply_loop } from '../modes/loop.js'
import { build_system_prompt } from '../modes/prompt.js'
import { setup_credentials } from '../credentials/index.js'
import { start_monitor } from '../babysit/monitor.js'
import { start_caffeinate, stop_caffeinate } from '../utils/caffeinate.js'
import { remove_docker_container } from '../docker/file_transport.js'

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
    ignore_host_agents_md: modifiers.includes( `ignore-host-agents-md` ),
} )

/**
 * Load babysit config for a detached monitor using the original launch mode.
 * @param {Object} session - Stored session metadata
 * @returns {{ config: Object, rules: Array }} Parsed config and rules
 */
export const load_monitor_config = ( session = {} ) => load_config( session.pwd, {
    default_initial_prompt: build_system_prompt( mode_from_modifiers( session.modifiers ) ),
} )

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

    // Restore the original working directory so cwd-relative paths in
    // babysit.yaml (./IDLE.md, ./LOOP.md) resolve the same way the
    // foreground saw them when it parsed the rules.
    if( session.pwd && existsSync( session.pwd ) ) {
        try {
            process.chdir( session.pwd )
        } catch ( e ) {
            log.warn( `Could not chdir to ${ session.pwd }: ${ e.message }` )
        }
    }

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

    const cleanup_credentials = async () => {
        if( credentials_cleaned ) return true
        if( !credential_setup_complete ) {
            const has_recovery_files = Object.keys( existing_tmpfiles ).length > 0
            if( has_recovery_files ) {
                log.warn( `Credential recovery could not start; retaining container and private recovery files.` )
                return false
            }

            return true
        }
        if( !creds_sync ) return true
        if( credential_cleanup_task ) return credential_cleanup_task

        credential_cleanup_task = ( async () => {
            try {
                await creds_sync.stop()
                if( !creds_sync.cleanup() ) {
                    log.warn( `Could not remove private credential recovery files; retaining the stopped container for retry.` )
                    return false
                }
                credentials_cleaned = true
                return true
            } catch ( error ) {
                log.warn(
                    `Could not flush completed session credentials; retaining container and private recovery files: ${ error.message }`
                )
                return false
            } finally {
                credential_cleanup_task = null
            }
        } )()

        return credential_cleanup_task
    }

    const cleanup_container = async () => {
        if( container_cleaned || !session.container_id ) return

        try {
            await remove_docker_container( session.container_id )
            container_cleaned = true
        } catch ( error ) {
            log.debug( `Could not remove completed Docker container ${ session.container_id }: ${ error.message }` )
        }
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
            apply_loop( rules, session.pwd, {
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
        if( await cleanup_credentials() ) await cleanup_container()
        stop_caffeinate( caffeinate )
    }

    log.info( `Monitor exited for session ${ session.babysit_id }` )

}
