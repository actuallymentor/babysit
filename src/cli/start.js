import { spawn, execSync } from 'child_process'
import { createInterface } from 'readline/promises'

import { log } from '../utils/log.js'
import { ensure_dirs, TMUX_SOCKET } from '../utils/paths.js'
import { get_agent } from '../agents/index.js'
import { load_config } from '../babysit/yaml.js'
import { setup_credentials } from '../credentials/index.js'
import { build_docker_command } from '../docker/run.js'
import { build_system_prompt } from '../modes/prompt.js'
import { apply_loop } from '../modes/loop.js'
import { create_session, make_session_name, has_session } from '../tmux/session.js'
import { send_text } from '../tmux/send.js'
import { save_session, load_session, generate_session_id } from '../sessions/store.js'
import { write_loop_deadline } from '../statusline/render.js'
import { resolve_log_path, append_session_header } from '../utils/log_file.js'
import { DEFAULT_DOCKER_SOCKET, docker_socket_available } from '../docker/run.js'

/**
 * Resolve the prompt babysit types into the agent pane once the TUI launches.
 * @param {Object} config - babysit.yaml config section
 * @returns {string} Initial prompt text, or an empty string to disable
 */
export const resolve_initial_prompt = ( config = {} ) => {

    if( typeof config.initial_prompt !== `string` ) return ``
    if( config.initial_prompt === `` ) return ``

    return config.initial_prompt

}

/**
 * Decide whether Babysit should type the configured startup prompt.
 * Resume should reopen existing context without injecting a fresh launch
 * prompt as a new user message.
 * @param {Object} cmd - Parsed command
 * @returns {boolean}
 */
export const should_send_initial_prompt = ( cmd = {} ) => cmd.verb !== `resume`

/**
 * Decide if a Docker socket session needs explicit user confirmation.
 * @param {Object} mode - Mode config
 * @returns {boolean} True when Babysit should ask before continuing
 */
export const should_confirm_docker_restricted_mode = ( mode = {} ) => {

    const autonomy_mode = process.env.AGENT_AUTONOMY_MODE
    const is_autonomous = mode.yolo || autonomy_mode === `yolo`

    return mode.docker && ( mode.sandbox || mode.mudbox ) && !is_autonomous

}

/**
 * Parse the user's restricted-mode Docker confirmation answer.
 * @param {string} answer - User-entered answer
 * @returns {boolean} True when the answer explicitly allows continuing
 */
export const allows_docker_restricted_mode = ( answer = `` ) => /^y(es)?$/i.test( answer.trim() )

/**
 * Warn before combining Docker socket access with sandbox/mudbox semantics.
 * @param {Object} mode - Mode config
 * @param {Object} [io]
 * @param {NodeJS.ReadableStream} [io.input=process.stdin] - Prompt input
 * @param {NodeJS.WritableStream} [io.output=process.stdout] - Prompt output
 * @returns {Promise<boolean>} True when the user confirms
 */
export const confirm_docker_restricted_mode = async ( mode = {}, { input = process.stdin, output = process.stdout } = {} ) => {

    const restricted_mode = mode.sandbox ? `--sandbox` : `--mudbox`

    log.warn( `--docker mounts the host Docker socket into the Babysit container.` )
    log.warn( `${ restricted_mode } will not be isolated from host writes, because Docker can start sibling containers with host bind mounts.` )

    const rl = createInterface( { input, output } )
    try {
        const answer = await rl.question( `Continue with --docker ${ restricted_mode }? Type Y or n: ` )
        return allows_docker_restricted_mode( answer )
    } finally {
        rl.close()
    }

}

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

    // Build mode descriptor
    const mode = {
        yolo: flags.yolo,
        sandbox: flags.sandbox,
        mudbox: flags.mudbox,
        docker: flags.docker,
    }

    if( mode.docker && !docker_socket_available() ) {
        log.error( `--docker requested, but ${ DEFAULT_DOCKER_SOCKET } is not available on the host.` )
        process.exit( 1 )
    }

    if( should_confirm_docker_restricted_mode( mode ) ) {
        const confirmed = await confirm_docker_restricted_mode( mode )
        if( !confirmed ) {
            log.error( `Aborted --docker ${ mode.sandbox ? `--sandbox` : `--mudbox` } session.` )
            process.exit( 1 )
        }
    }

    // Load babysit.yaml (creates default if missing). New config files get
    // the generated mode-aware launch prompt written into config.initial_prompt;
    // after that, the YAML value is the only source of truth.
    const workspace = process.cwd()
    const { config, rules } = load_config( workspace, {
        default_initial_prompt: build_system_prompt( mode ),
    } )

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

    // Build the launch prompt that babysit types into the agent's TUI.
    // Null or an empty string intentionally disables startup typing.
    const initial_prompt = should_send_initial_prompt( cmd ) ? resolve_initial_prompt( config ) : ``

    // Set up credentials. The foreground owns the initial capture + docker
    // mount; the detached monitor will set up its own sync interval, so we
    // stop the foreground's sync as soon as the monitor is spawned to avoid
    // racing on the tmpfile.
    const {
        mounts: creds_mounts,
        sync: creds_sync,
        sync_baseline: creds_sync_baseline,
    } = await setup_credentials( agent )

    // Get agent-specific extra env
    const extra_env = agent.extra_env ? agent.extra_env( mode ) : {}

    // Handle resume by injecting the resume flag
    const agent_args = [ ...passthrough ]
    if( cmd.verb === `resume` ) {
        if( cmd.resume_latest && agent.flags.resume_latest ) {
            const resume_flag = agent.flags.resume_latest()
            if( Array.isArray( resume_flag ) ) agent_args.unshift( ...resume_flag )
            else agent_args.unshift( resume_flag )
        } else if( cmd.session_id && agent.flags.resume ) {
            const resume_flag = agent.flags.resume( cmd.session_id )
            if( Array.isArray( resume_flag ) ) agent_args.unshift( ...resume_flag )
            else agent_args.unshift( resume_flag )
        }
    }

    // Build the docker command
    const docker_command = build_docker_command( {
        agent, workspace, mode,
        agent_args, creds_mounts, config, extra_env, modifiers,
    } )

    // Start tmux output logging if --log was passed. The header goes in BEFORE
    // the pane command runs, so each session block opens with a clean
    // "Babysit session start: ..." line.
    let log_path = null
    if( typeof flags.log === `string` ) {

        const candidate = resolve_log_path( flags.log, { cwd: workspace } )
        if( append_session_header( candidate ) ) log_path = candidate

    }

    // Create tmux session (detached — we'll attach the foreground in a moment)
    const session_name = make_session_name( workspace, agent.name )
    const { pipe_started } = await create_session( session_name, docker_command, { log_path } )
    if( pipe_started ) log.info( `Logging tmux output to ${ log_path }` )

    if( initial_prompt ) {
        log.info( `Sending initial prompt` )
        await send_text( session_name, initial_prompt )
    }

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
        creds_sync_baseline,
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
    // stop() runs one final async flush. It is deliberately fire-and-forget:
    // if a fast-starting agent already refreshed the tmpfile, either this
    // flush or the monitor's baseline-aware sync will push it back to host.
    // Awaiting here would only delay attaching the user's terminal.
    if( creds_sync ) creds_sync.stop().catch( e => log.debug( `Foreground sync stop: ${ e.message }` ) )

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

    // Tell the user how to come back to or resume this session. Both branches
    // print the command unquoted on its own line so a triple-click selects it
    // cleanly for copy/paste. The bare `babysit resume <id>` form looks the
    // agent up from session metadata, so we don't need to pre-pend the agent
    // name.
    if( await has_session( session_name ) ) {
        console.log( `\nDetached. Re-attach with:\n\nbabysit open ${ babysit_id }\n` )
    } else {
        // Prefer the agent's own session id when the daemon captured it —
        // that's what the agent's CLI accepts for its native --resume flag,
        // and load_session knows how to resolve either form back to the record.
        const final = load_session( babysit_id ) || session_data
        const resume_id = final.agent_session_id || babysit_id
        console.log( `\nTo resume this session, run:\nbabysit resume ${ resume_id }` )
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
