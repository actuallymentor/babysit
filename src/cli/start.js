import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import { log } from '../utils/log.js'
import { ensure_dirs } from '../utils/paths.js'
import { check_dependencies } from '../deps/check.js'
import { run_self_update } from '../deps/selfupdate.js'
import { get_agent } from '../agents/index.js'
import { get_patterns } from '../patterns/index.js'
import { load_config } from '../babysit/yaml.js'
import { setup_credentials } from '../credentials/index.js'
import { build_docker_command } from '../docker/run.js'
import { build_system_prompt } from '../modes/prompt.js'
import { apply_loop } from '../modes/loop.js'
import { create_session, make_session_name } from '../tmux/session.js'
import { start_monitor } from '../babysit/monitor.js'
import { save_session, update_session, generate_session_id } from '../sessions/store.js'

/**
 * Start a new babysit session
 * @param {Object} cmd - Parsed command { agent, flags, passthrough }
 */
export const cmd_start = async ( cmd ) => {

    const { agent: agent_name, flags, passthrough } = cmd

    // Resolve the agent adapter
    const agent = get_agent( agent_name )
    if( !agent ) {
        log.error( `Unknown agent: ${ agent_name }` )
        process.exit( 1 )
    }

    // Check system dependencies
    if( !check_dependencies() ) {
        log.error( `Missing dependencies. Install them and try again.` )
        process.exit( 1 )
    }

    ensure_dirs()

    // Pre-flight updates (unless --no-update)
    if( !flags.no_update ) {
        log.info( `Running pre-flight updates...` )
        await run_self_update()
    }

    // Load babysit.yaml (creates default if missing)
    const workspace = process.cwd()
    const { config, rules } = load_config( workspace )

    // Build mode descriptor
    const mode = {
        yolo: flags.yolo,
        sandbox: flags.sandbox,
        mudbox: flags.mudbox,
    }

    // Apply loop override if --loop flag is set
    if( flags.loop ) apply_loop( rules, workspace )

    // Build system prompt
    const system_prompt = build_system_prompt( mode )

    // Set up credentials
    const { mounts: creds_mounts, sync: creds_sync } = await setup_credentials( agent )

    // Get agent-specific extra env
    const extra_env = agent.extra_env ? agent.extra_env( mode ) : {}

    // Handle resume by injecting the resume flag
    const agent_args = [ ...passthrough ]
    if( cmd.verb === `resume` && cmd.session_id ) {
        if( agent.flags.resume ) {
            const resume_flag = agent.flags.resume( cmd.session_id )
            if( Array.isArray( resume_flag ) ) agent_args.unshift( ...resume_flag )
            else agent_args.unshift( resume_flag )
        }
    }

    // Build the docker command
    const docker_command = build_docker_command( {
        agent, workspace, mode, system_prompt,
        agent_args, creds_mounts, config, extra_env,
    } )

    // Create tmux session
    const session_name = make_session_name( workspace, agent.name )
    await create_session( session_name, docker_command )

    // Generate and save session metadata
    const babysit_id = generate_session_id()
    const modifiers = Object.entries( mode ).filter( ( [ , v ] ) => v ).map( ( [ k ] ) => k )
    if( flags.loop ) modifiers.push( `loop` )

    const session_data = {
        babysit_id,
        agent: agent.name,
        agent_session_id: null,
        tmux_session: session_name,
        pwd: workspace,
        modifiers,
        creds_tmpfile: creds_mounts.find( m => m.type === `volume` )?.source || null,
        creds_sync_pid: null,
        started_at: new Date().toISOString(),
    }
    save_session( session_data )

    log.info( `Session started: ${ agent.name } (${ babysit_id })` )
    log.info( `Tmux session: ${ session_name }` )
    log.info( `Attach with: tmux -L babysit attach -t ${ session_name }` )

    // Get agent patterns for monitoring
    const agent_patterns = get_patterns( agent.name )

    // Start the monitor loop (runs until session exits)
    await start_monitor( {
        session_name,
        config,
        rules,
        agent_patterns,
        agent,
        on_session_id: ( id ) => {
            update_session( babysit_id, { agent_session_id: id } )
        },
        on_exit: () => {

            // Stop credential sync daemon
            if( creds_sync ) creds_sync.stop()

            // Load the final session data to get the captured agent_session_id
            const final_data = { ...session_data }
            try {
                const stored = readFileSync(
                    join( homedir(), `.babysit`, `sessions`, `${ babysit_id }.json` ),
                    `utf-8`
                )
                Object.assign( final_data, JSON.parse( stored ) )
            } catch { /* ignore */ }

            const resume_id = final_data.agent_session_id || babysit_id
            console.log( `\nTo resume this session, run \`babysit ${ agent.name } resume ${ resume_id }\`` )

        },
    } )

}
