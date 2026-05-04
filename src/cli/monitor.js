import { existsSync } from 'fs'

import { log } from '../utils/log.js'
import { load_session, update_session } from '../sessions/store.js'
import { load_config } from '../babysit/yaml.js'
import { get_agent } from '../agents/index.js'
import { get_patterns } from '../patterns/index.js'
import { apply_loop } from '../modes/loop.js'
import { setup_credentials } from '../credentials/index.js'
import { start_monitor } from '../babysit/monitor.js'
import { start_caffeinate, stop_caffeinate } from '../utils/caffeinate.js'

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

    const { config, rules } = load_config( session.pwd )

    // Re-apply --loop if it was active in the original session — the rule
    // override mutates `rules` in place, so the monitor will see the LOOP.md
    // action wired up to the idle rule.
    if( session.modifiers?.includes( `loop` ) ) apply_loop( rules, session.pwd )

    const agent = get_agent( session.agent )
    const agent_patterns = get_patterns( session.agent )

    // Set up our own credential sync. The foreground process owns the initial
    // capture and the docker mount, but its setInterval dies with it — without
    // this, tokens would stop refreshing the moment the user detaches.
    //
    // CRITICAL: pass `existing_tmpfile` so the monitor's sync watches the SAME
    // tmpfile the container is already mounting. `copy_host_file_to_tmpfile`
    // bakes Date.now() into the path, so a fresh setup_credentials call would
    // mint a brand-new tmpfile that nobody writes to — and the container's
    // OAuth refreshes (the whole reason for bidirectional sync) would never
    // make it back to the host file. Symptom: "Your access token could not be
    // refreshed because your refresh token was already used" on the NEXT
    // babysit session, every time.
    const { sync: creds_sync } = await setup_credentials( agent, {
        existing_tmpfile: session.creds_tmpfile,
        sync_baseline: session.creds_sync_baseline,
    } )

    log.info( `Monitor watching session ${ session.babysit_id } (${ session.tmux_session })` )

    const caffeinate = start_caffeinate()

    try {

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
                if( creds_sync ) await creds_sync.stop()
            },
        } )

    } finally {
        stop_caffeinate( caffeinate )
    }

    log.info( `Monitor exited for session ${ session.babysit_id }` )

}
