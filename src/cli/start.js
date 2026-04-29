import { spawn, execSync } from 'child_process'

import { log } from '../utils/log.js'
import { ensure_dirs, TMUX_SOCKET } from '../utils/paths.js'
import { get_agent } from '../agents/index.js'
import { load_config } from '../babysit/yaml.js'
import { setup_credentials } from '../credentials/index.js'
import { build_docker_command } from '../docker/run.js'
import { build_system_prompt } from '../modes/prompt.js'
import { apply_loop } from '../modes/loop.js'
import { create_session, make_session_name, has_session } from '../tmux/session.js'
import { save_session, load_session, generate_session_id } from '../sessions/store.js'
import { write_loop_deadline } from '../statusline/render.js'

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

    ensure_dirs()

    // Load babysit.yaml (creates default if missing)
    const workspace = process.cwd()
    const { config, rules } = load_config( workspace )

    // Build mode descriptor
    const mode = {
        yolo: flags.yolo,
        sandbox: flags.sandbox,
        mudbox: flags.mudbox,
    }

    // Compute the modifier list for the statusline + session metadata
    const modifiers = Object.entries( mode ).filter( ( [ , v ] ) => v ).map( ( [ k ] ) => k )
    if( flags.loop ) modifiers.push( `loop` )

    // Initialize the loop deadline file before docker mounts it.
    // "idle" tells the statusline there's no active countdown yet.
    write_loop_deadline( `idle` )

    // Apply loop override if --loop flag is set. The detached monitor will
    // re-apply this when it boots, but doing it here too is harmless and
    // keeps the rules object internally consistent during the foreground.
    if( flags.loop ) apply_loop( rules, workspace )

    // Build system prompt
    const system_prompt = build_system_prompt( mode )

    // Set up credentials. The foreground owns the initial capture + docker
    // mount; the detached monitor will set up its own sync interval, so we
    // stop the foreground's sync as soon as the monitor is spawned to avoid
    // racing on the tmpfile.
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
        agent_args, creds_mounts, config, extra_env, modifiers,
    } )

    // Create tmux session (detached — we'll attach the foreground in a moment)
    const session_name = make_session_name( workspace, agent.name )
    await create_session( session_name, docker_command )

    // Generate and save session metadata before spawning the monitor — the
    // monitor reads this file to reconstruct config, agent, and tmux session
    // name, so it must exist before the spawn.
    const babysit_id = generate_session_id()

    const session_data = {
        babysit_id,
        agent: agent.name,
        agent_session_id: null,
        tmux_session: session_name,
        pwd: workspace,
        modifiers,
        creds_tmpfile: creds_mounts.find( m => m.type === `volume` )?.source || null,
        started_at: new Date().toISOString(),
    }
    save_session( session_data )

    log.info( `Session started: ${ agent.name } (${ babysit_id })` )

    // Spawn the supervision loop as a detached background process. It re-loads
    // config + agent state from session metadata and runs `start_monitor`
    // independently, so it survives the foreground process exiting (which
    // happens as soon as the user detaches from tmux below).
    spawn_monitor_daemon( babysit_id )

    // Hand the foreground's credential sync over to the detached monitor.
    // Both sync intervals would race on the same tmpfile if we left this one
    // running; the monitor's sync started inside the daemon a moment ago.
    if( creds_sync ) creds_sync.stop()

    // Hand the user's terminal over to tmux. Blocks until they detach
    // (Ctrl+B d) or the agent exits and the session terminates.
    log.info( `Attaching to tmux session: ${ session_name }` )
    try {
        execSync(
            `tmux -L ${ TMUX_SOCKET } attach -t ${ JSON.stringify( session_name ) }`,
            { stdio: `inherit` }
        )
    } catch ( e ) {
        // tmux exits non-zero on certain detach scenarios — that's normal
        log.debug( `tmux attach exited: ${ e.message }` )
    }

    // Tell the user how to come back to or resume this session
    if( await has_session( session_name ) ) {
        console.log( `\nDetached. Re-attach with \`babysit open ${ babysit_id }\`` )
    } else {
        // Session ended. The detached monitor would have updated the
        // metadata with the agent's own session id by now, so prefer that
        // (it's the id the agent's CLI accepts for `--resume`).
        const final = load_session( babysit_id ) || session_data
        const resume_id = final.agent_session_id || babysit_id
        console.log( `\nSession ended. Resume with \`babysit ${ agent.name } resume ${ resume_id }\`` )
    }

}

/**
 * Spawn `babysit __monitor <id>` as a detached background process.
 * Works for both `node src/index.js` and bun-compiled binaries by detecting
 * which one is running and re-spawning accordingly.
 * @param {string} babysit_id - The session id to monitor
 */
const spawn_monitor_daemon = ( babysit_id ) => {

    // Bun-compiled binaries set process.argv[1] to a synthetic /$bunfs path;
    // a real node script puts the .js file there. process.execPath points at
    // the binary or `node` respectively in both cases — re-spawning it with
    // the right args runs the same babysit code path.
    const argv1 = process.argv[1] || ``
    const is_compiled = argv1.startsWith( `/$bunfs` ) || argv1 === ``

    const cmd = process.execPath
    const args = is_compiled
        ? [ `__monitor`, babysit_id ]
        : [ argv1, `__monitor`, babysit_id ]

    const child = spawn( cmd, args, {
        detached: true,
        stdio: `ignore`,
        env: { ...process.env },
    } )

    child.unref()
    log.debug( `Monitor daemon spawned (pid ${ child.pid })` )

}
