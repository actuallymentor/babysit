import { spawn, execSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createInterface } from 'readline/promises'
import { wait } from 'mentie'

import { log, print_error } from '../utils/log.js'
import { BABYSIT_DIR, ensure_dirs, TMUX_SOCKET } from '../utils/paths.js'
import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import { load_config } from '../babysit/yaml.js'
import { cleanup_stale_ephemeral_credential_mounts, setup_credentials } from '../credentials/index.js'
import {
    clear_credential_recovery,
    list_credential_recoveries,
    register_credential_recovery,
} from '../credentials/recovery.js'
import { setup_github_cli_credentials } from '../credentials/github.js'
import { private_credential_tmpdir } from '../utils/tmpfile.js'
import {
    DEFAULT_DOCKER_SOCKET,
    docker_daemon_status,
    resolve_docker_socket_path,
} from '../docker/run.js'
import { prepare_docker_launch } from '../docker/launch.js'
import { warn_if_unrecognized_watchtower_is_running } from '../docker/watchtower.js'
import { build_system_prompt } from '../modes/prompt.js'
import {
    check_host_agent_authentication,
    confirm_continue_with_unauthenticated_agents,
    failed_agent_names,
    resolve_host_auth_context_files,
    resolve_host_auth_context_values,
    run_host_agent_auth_check,
    unauthenticated_agent_names,
} from '../agents/auth.js'
import {
    clear_host_auth_cache,
    credential_mounts_for_agent,
    find_host_auth_cache_hit,
    fingerprint_agent_credentials,
    record_host_auth_success,
    refresh_file_credential_parts,
    refresh_host_auth_cache,
    resolve_auth_image_identity,
} from '../agents/auth_cache.js'
import { acquire_host_auth_lease } from '../agents/auth_lease.js'
import { run_auth_checks_with_progress } from './auth_progress.js'
import { apply_loop } from '../modes/loop.js'
import { create_session, make_session_name, has_session } from '../tmux/session.js'
import { send_text } from '../tmux/send.js'
import { capture_pane, stop_pipe_pane } from '../tmux/capture.js'
import { save_session, load_session, list_stored_sessions, generate_session_id } from '../sessions/store.js'
import { write_loop_deadline } from '../statusline/render.js'
import { resolve_log_path, append_session_header } from '../utils/log_file.js'
import { strip_ansi } from '../babysit/matcher.js'
import { time_phase, time_phase_sync } from '../utils/timing.js'
import { command_exists } from '../utils/exec.js'

const INITIAL_PROMPT_READY_TIMEOUT_MS = 60_000
const INITIAL_PROMPT_READY_INTERVAL_MS = 250
const STARTUP_EXIT_GRACE_MS = 750
const STARTUP_LOG_TAIL_LINES = 80
const monotonic_now = () => performance.now()

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
 * Resolve stored Babysit metadata for explicit agent resume commands.
 * @param {Object} cmd - Parsed command
 * @param {Object} agent - Agent adapter
 * @param {Function} [session_loader=load_session] - Metadata lookup helper
 * @returns {Object|null} Stored session, optional agent_mismatch field, or null
 */
export const resolve_stored_agent_resume_session = ( cmd = {}, agent = {}, session_loader = load_session ) => {

    if( cmd.verb !== `resume` || !cmd.session_id ) return null

    const stored = session_loader( cmd.session_id )
    if( !stored ) return null

    if( stored.agent && agent.name && stored.agent !== agent.name ) {
        return { ...stored, agent_mismatch: stored.agent }
    }

    return stored

}

/**
 * Resolve the human-readable name for a new or resumed active session.
 * @param {Object} flags - Parsed command flags
 * @param {Object|null} stored_resume_session - Stored explicit-agent resume metadata
 * @returns {string|null} Session name to persist
 */
export const resolve_session_display_name = ( flags = {}, stored_resume_session = null ) =>
    flags.name || stored_resume_session?.name || null

/**
 * Keep host-profile isolation sticky when an explicit-agent resume resolves
 * to Babysit metadata. Fresh command-line flags still work for native ids.
 * @param {Object} flags - Parsed command flags
 * @param {Object|null} stored_resume_session - Stored explicit-agent resume metadata
 * @returns {boolean} Whether host agent context must stay isolated
 */
export const should_ignore_host_agent_context = ( flags = {}, stored_resume_session = null ) =>
    Boolean(
        flags.ignore_host_agents_md
        || stored_resume_session?.modifiers?.includes( `ignore-host-agents-md` )
    )

/**
 * Tear down a failed foreground launch without destroying the only copy of a
 * credential that may have rotated inside Docker. A failed final flush keeps
 * both the stopped container and private local sync files for recovery.
 *
 * @param {Object} [options]
 * @param {Object|null} [options.creds_sync] - Aggregate credential sync controller
 * @param {Object|null} [options.prepared_launch] - Prepared Docker launch owner
 * @param {string|null} [options.recovery_id] - Pre-container credential owner
 * @param {Function} [options.clear_recovery=clear_credential_recovery] - Recovery marker cleanup
 * @param {string} [options.context] - Human-readable failure context
 * @returns {Promise<{ cleaned: boolean, retained_container: string|null, flush_error: Error|null }>}
 */
export const cleanup_failed_launch_credentials = async ( {
    creds_sync = null,
    prepared_launch = null,
    recovery_id = null,
    clear_recovery = clear_credential_recovery,
    context = `foreground launch failure`,
} = {} ) => {

    let flush_error = null

    if( creds_sync ) {
        try {
            await creds_sync.stop()
        } catch ( error ) {
            flush_error = error
        }
    }

    if( flush_error ) {
        const retained_container = prepared_launch?.retain
            ? await prepared_launch.retain( { stop: true } )
            : null
        if( prepared_launch && !prepared_launch.retain ) prepared_launch.handoff?.()

        log.warn(
            `Could not flush credentials after ${ context }; retaining ${ retained_container || `private recovery files` } for manual recovery: ${ flush_error.message }`
        )
        return { cleaned: false, retained_container, flush_error }
    }

    const files_cleaned = creds_sync ? creds_sync.cleanup() : true
    const recovery_cleared = clear_recovery( recovery_id )
    const cleaned = files_cleaned && recovery_cleared
    if( !cleaned ) log.warn( `Could not remove private credential recovery files after ${ context }.` )
    if( prepared_launch ) await prepared_launch.abort()

    return { cleaned, retained_container: null, flush_error: null }

}

/**
 * Resolve explicit agent resume targets.
 * `babysit <agent> resume <babysit_id>` should translate the Babysit metadata
 * id before it reaches the agent CLI. If there is no stored record, treat the
 * id as a native agent id so power users can still run direct resumes.
 * @param {Object} cmd - Parsed command
 * @param {Object} agent - Agent adapter
 * @param {Function} [session_loader=load_session] - Metadata lookup helper
 * @returns {{ session_id: string|null, resume_latest: boolean, agent_mismatch?: string }}
 */
export const resolve_agent_resume_target = ( cmd = {}, agent = {}, session_loader = load_session ) => {

    if( cmd.verb !== `resume` ) {
        return {
            session_id: cmd.session_id || null,
            resume_latest: Boolean( cmd.resume_latest ),
        }
    }

    if( cmd.resume_latest ) {
        return {
            session_id: null,
            resume_latest: true,
        }
    }

    if( !cmd.session_id ) {
        return {
            session_id: null,
            resume_latest: false,
        }
    }

    const stored = session_loader( cmd.session_id )
    if( !stored ) {
        return {
            session_id: cmd.session_id,
            resume_latest: false,
        }
    }

    if( stored.agent && agent.name && stored.agent !== agent.name ) {
        return {
            session_id: cmd.session_id,
            resume_latest: false,
            agent_mismatch: stored.agent,
        }
    }

    if( stored.agent_session_id ) {
        return {
            session_id: stored.agent_session_id,
            resume_latest: false,
        }
    }

    return {
        session_id: null,
        resume_latest: true,
    }

}

/**
 * Check whether an agent pane has reached the point where startup text can be
 * pasted without racing terminal-mode setup.
 * @param {Object} agent - Agent adapter
 * @param {string} output - Raw pane output
 * @returns {boolean} True when the agent has no readiness gate or it matches
 */
export const is_initial_prompt_ready = ( agent = {}, output = `` ) => {

    const clean = strip_ansi( output )
    if( typeof agent.initial_prompt_ready === `function` ) {
        return agent.initial_prompt_ready( clean )
    }

    const pattern = agent.initial_prompt_ready_pattern
    if( !pattern ) return true

    pattern.lastIndex = 0
    return pattern.test( clean )

}

/**
 * Resolve an adapter-specific startup-composer deadline.
 * @param {Object} agent - Active agent adapter
 * @returns {number} Readiness timeout in milliseconds
 */
export const resolve_initial_prompt_ready_timeout = ( agent = {} ) =>
    agent.initial_prompt_ready_timeout_ms || INITIAL_PROMPT_READY_TIMEOUT_MS

/**
 * Wait for the agent TUI to be ready before typing the startup prompt.
 * Agents without a readiness gate are considered ready immediately.
 * @param {string} session_name - Tmux session name
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {Function} [options.capture=capture_pane] - Pane capture helper
 * @param {Function} [options.debug=log.debug] - Diagnostic logger
 * @param {Function} [options.has_session_fn=has_session] - Session liveness helper
 * @param {Function} [options.wait_fn=wait] - Sleep helper
 * @param {Function} [options.now_fn=performance.now] - Monotonic clock helper
 * @param {number} [options.timeout_ms] - Max wait before giving up
 * @param {number} [options.interval_ms=250] - Poll interval
 * @returns {Promise<boolean>} True when ready, false on timeout
 */
export const wait_for_initial_prompt_ready = async ( session_name, agent = {}, {
    capture = capture_pane,
    debug = message => process.env.BABYSIT_DEBUG === `1`
        ? log.info( message )
        : log.debug( message ),
    has_session_fn = has_session,
    wait_fn = wait,
    now_fn = monotonic_now,
    timeout_ms = resolve_initial_prompt_ready_timeout( agent ),
    interval_ms = INITIAL_PROMPT_READY_INTERVAL_MS,
} = {} ) => {

    if( !agent.initial_prompt_ready && !agent.initial_prompt_ready_pattern ) return true

    const deadline = now_fn() + timeout_ms
    let first_attempt = true
    let last_output = ``

    while( first_attempt || now_fn() < deadline ) {

        first_attempt = false
        const capture_timeout_ms = Math.max( 1, Math.min( 1_000, deadline - now_fn() ) )

        try {
            const output = await capture( session_name, capture_timeout_ms )
            last_output = output
            if( is_initial_prompt_ready( agent, output ) ) return true
        } catch {
            // Capture can race a tmux repaint, but a dead pane will never
            // become ready. Avoid hiding the launch failure for a full minute.
            if( !await has_session_fn( session_name ) ) return false
        }

        const remaining_ms = deadline - now_fn()
        if( remaining_ms <= 0 ) break

        await wait_fn( Math.min( interval_ms, remaining_ms ) )

    }

    const diagnostic = strip_ansi( last_output ).trim()
    if( diagnostic ) {
        debug( `${ agent.name || `Agent` } pane at initial-prompt readiness timeout:\n${ diagnostic }` )
    }

    return false

}

/**
 * Create the short-lived diagnostic path used before a launch is known-good.
 * @param {string} session_name - Tmux session name
 * @param {Object} [options]
 * @param {string} [options.babysit_dir] - Base Babysit state directory
 * @returns {string} Absolute diagnostic log path
 */
export const startup_diagnostic_log_path = ( session_name, {
    babysit_dir = BABYSIT_DIR,
} = {} ) => {

    const safe_name = session_name
        .replace( /[^a-zA-Z0-9_.-]/g, `_` )
        .slice( 0, 180 )

    const dir = join( babysit_dir, `launch-logs` )
    mkdirSync( dir, { recursive: true } )

    return join( dir, `${ safe_name }.log` )

}

/**
 * Read a concise, plain-text tail from a startup diagnostic log.
 * @param {string|null} log_path - Diagnostic log path
 * @param {Object} [options]
 * @param {number} [options.max_lines=80] - Maximum lines to return
 * @returns {string} Log tail, stripped of ANSI control sequences
 */
export const read_startup_log_tail = ( log_path, {
    max_lines = STARTUP_LOG_TAIL_LINES,
} = {} ) => {

    if( !log_path ) return ``

    try {
        const raw = readFileSync( log_path, `utf8` )
        const clean = strip_ansi( raw ).replace( /\r/g, `` )
        const lines = clean
            .split( `\n` )
            .map( line => line.trimEnd() )
            .filter( line => line.trim() )

        return lines.slice( -max_lines ).join( `\n` ).trim()
    } catch {
        return ``
    }

}

/**
 * Remove a short-lived startup diagnostic log after a healthy launch.
 * @param {string|null} log_path - Diagnostic log path
 */
const remove_startup_diagnostic_log = ( log_path ) => {

    if( !log_path ) return

    try {
        rmSync( log_path, { force: true } )
    } catch {
        // Best effort cleanup only.
    }

}

/**
 * Stop the internal diagnostic pipe once startup has succeeded.
 * @param {string} session_name - Tmux session name
 * @param {Object} options
 * @param {boolean} options.uses_user_log - True when --log owns pipe-pane
 * @param {boolean} options.pipe_started - True when pipe-pane started
 * @param {string|null} options.diagnostic_log_path - Internal diagnostic path
 */
const stop_startup_diagnostics = async ( session_name, {
    uses_user_log,
    pipe_started,
    diagnostic_log_path,
} ) => {

    if( uses_user_log || !pipe_started ) return

    try {
        await stop_pipe_pane( session_name )
    } catch ( e ) {
        log.debug( `Could not stop startup diagnostics: ${ e.message }` )
    }

    remove_startup_diagnostic_log( diagnostic_log_path )

}

/**
 * Print the real startup output when the tmux session dies before attach.
 * @param {Object} agent - Agent adapter
 * @param {string|null} diagnostic_log_path - Startup diagnostic path
 */
export const report_startup_failure = ( agent = {}, diagnostic_log_path = null ) => {

    const output = read_startup_log_tail( diagnostic_log_path )
    const name = agent.name || `agent`

    print_error( `${ name } exited before Babysit could attach.` )

    if( output ) {
        print_error( `Startup output:` )
        output.split( `\n` ).forEach( line => print_error( `  ${ line }` ) )
    } else {
        print_error( `No startup output was captured. Re-run with --log=PATH for full pane output.` )
    }

}

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
 * Select startup auth probes. The active frontend always remains first because
 * Babysit can launch it from the image even when no host binary exists. Other
 * agents are relevant only when their host CLI resolves on PATH.
 *
 * @param {Object} active_agent - Active frontend adapter
 * @param {Object} [options]
 * @param {Object[]} [options.candidates] - Supported candidate adapters
 * @param {Function} [options.is_installed] - Host CLI detector
 * @returns {Object[]} Active-first, deduplicated adapters
 */
export const select_startup_auth_agents = ( active_agent, {
    candidates = SUPPORTED_AGENTS.map( get_agent ).filter( Boolean ),
    is_installed = candidate => command_exists( candidate.bin ),
} = {} ) => {

    const unique_candidates = [ ...new Map(
        candidates.filter( Boolean ).map( candidate => [ candidate.name, candidate ] )
    ).values() ]
    const installed_candidates = unique_candidates.filter( candidate =>
        candidate?.name
        && candidate.name !== active_agent?.name
        && is_installed( candidate )
    )
    const selected = [ active_agent, ...installed_candidates ].filter( Boolean )

    return [ ...new Map( selected.map( candidate => [ candidate.name, candidate ] ) ).values() ]

}

/**
 * Decide whether startup needs the fail-closed confirmation prompt.
 * Pressing Enter skips the whole batch decision even when one probe failed
 * before cancellation reached its siblings.
 *
 * @param {Object[]} results - Authentication results
 * @param {boolean} skipped - Batch-level user skip decision
 * @returns {boolean} Whether to ask Exit? [Y/n]
 */
export const should_confirm_startup_authentication = ( results = [], skipped = false ) =>
    !skipped && Boolean(
        unauthenticated_agent_names( results ).length
        || failed_agent_names( results ).length
    )

/**
 * Check the active agent plus host-installed supported agents, reusing fresh
 * hash-bound successes and running every miss concurrently. The main session
 * still receives all captured credentials so nested agent calls work; each
 * throwaway probe receives only its own credential descriptors.
 *
 * @param {Object} agent - Active agent adapter
 * @param {Object} options - Launch authentication context
 * @returns {Promise<{ results: Object[], skipped: boolean, cache_context: Object|null, cache_contexts: Object }>} Results and safe trust metadata
 */
export const check_startup_agent_authentication = async ( agent, {
    workspace,
    mode,
    creds_mounts,
    input = process.stdin,
    output = process.stdout,
    cache_path = undefined,
    resolve_image_identity = resolve_auth_image_identity,
    resolve_context_files = resolve_host_auth_context_files,
    resolve_context_values = resolve_host_auth_context_values,
    run_auth_check = run_host_agent_auth_check,
    agents = SUPPORTED_AGENTS.map( get_agent ).filter( Boolean ),
    is_host_cli_installed = candidate => command_exists( candidate.bin ),
    agent_args = [],
    reconcile_credentials = async () => {},
    credential_source_changed = () => false,
} ) => {

    const selected_agents = select_startup_auth_agents( agent, {
        candidates: agents,
        is_installed: is_host_cli_installed,
    } )
    const cache_options = cache_path ? { cache_path } : {}
    const context_files = new Map( selected_agents.map( candidate => [
        candidate.name,
        resolve_context_files( mode, { agent: candidate } ),
    ] ) )
    const context_values = new Map( selected_agents.map( candidate => [
        candidate.name,
        resolve_context_values(
            candidate,
            candidate.name === agent.name ? agent_args : [],
            {
                workspace,
                include_host_preferences: !mode.ignore_host_agents_md,
            }
        ),
    ] ) )
    const credential_identities = new Map( selected_agents.map( candidate => [
        candidate.name,
        fingerprint_agent_credentials( candidate, creds_mounts, {
            context_files: context_files.get( candidate.name ),
            context_values: context_values.get( candidate.name ),
        } ),
    ] ) )
    const has_cacheable_identity = [ ...credential_identities.values() ].some( Boolean )
    const image_identity = has_cacheable_identity ? await resolve_image_identity() : null
    const cached_results = []
    const cache_contexts = {}
    const agents_to_check = []

    selected_agents.forEach( candidate => {
        const identity = credential_identities.get( candidate.name )
        const cached = identity && find_host_auth_cache_hit( candidate.name, {
            credential_fingerprint: identity.fingerprint,
            image_identity,
        }, cache_options )

        if( !cached ) {
            agents_to_check.push( candidate )
            return
        }

        log.info( `Authentication cache hit: ${ candidate.name }` )
        cached_results.push( {
            name: candidate.name,
            status: `cached`,
            authenticated: true,
        } )
        cache_contexts[ candidate.name ] = {
            credential_fingerprint: identity.fingerprint,
            credential_parts: identity.parts,
            image_identity,
        }
    } )

    const checked_batch = agents_to_check.length
        ? await run_auth_checks_with_progress( agents_to_check, ( { signal, on_state } ) =>
            check_host_agent_authentication( {
                agents: agents_to_check,
                signal,
                on_state,
                run_auth_check: async ( auth_agent, options ) => {
                    const result = await run_auth_check( auth_agent, {
                        ...options,
                        workspace,
                        mode,
                        creds_mounts: credential_mounts_for_agent( auth_agent, creds_mounts ),
                        config: { isolate_dependencies: false },
                        agent_args: auth_agent.name === agent.name ? agent_args : [],
                    } )
                    if( result.status !== `authenticated` ) return result

                    try {
                        await reconcile_credentials( auth_agent.name )
                    } catch ( error ) {
                        return {
                            ...result,
                            status: `failed`,
                            authenticated: false,
                            reason: `credential reconciliation failed: ${ error.message }`,
                        }
                    }

                    if( credential_source_changed( auth_agent.name ) ) {
                        return {
                            ...result,
                            status: `failed`,
                            authenticated: false,
                            reason: `host credentials changed during authentication`,
                        }
                    }

                    return result
                },
            } ), {
            input,
            output,
        } )
        : { results: [], skipped: false }
    const checked_results = checked_batch.results

    checked_results.forEach( result => {
        if( result.status !== `authenticated` ) {
            if( [ `unauthenticated`, `failed` ].includes( result.status ) ) {
                const observed_identity = credential_identities.get( result.name )
                clear_host_auth_cache( result.name, {
                    ...cache_options,
                    expected_credential_fingerprint: observed_identity?.fingerprint,
                    image_identity,
                } )
            }
            return
        }

        // A real probe can rotate OAuth credentials. Fingerprint only after
        // that probe's final credential pull has completed.
        const checked_agent = get_agent( result.name )
        const verified_context_values = resolve_context_values(
            checked_agent,
            checked_agent.name === agent.name ? agent_args : [],
            {
                workspace,
                include_host_preferences: !mode.ignore_host_agents_md,
            }
        )
        const identity = fingerprint_agent_credentials( checked_agent, creds_mounts, {
            context_files: context_files.get( checked_agent.name ),
            context_values: verified_context_values,
        } )
        const initial_context = credential_identities.get( result.name )?.parts
            ?.filter( part => [ `context`, `value` ].includes( part.kind ) )
        const verified_context = identity?.parts
            .filter( part => [ `context`, `value` ].includes( part.kind ) )
        if( JSON.stringify( initial_context ) !== JSON.stringify( verified_context ) ) {
            result.status = `failed`
            result.authenticated = false
            result.reason = `authentication context changed during the check`
            clear_host_auth_cache( result.name, {
                ...cache_options,
                expected_credential_fingerprint: credential_identities.get( result.name )?.fingerprint,
                image_identity,
            } )
            return
        }
        if( !identity || !image_identity ) return

        record_host_auth_success( result.name, {
            credential_fingerprint: identity.fingerprint,
            image_identity,
        }, cache_options )
        cache_contexts[ result.name ] = {
            credential_fingerprint: identity.fingerprint,
            credential_parts: identity.parts,
            image_identity,
        }
    } )

    const results_by_name = new Map(
        [ ...cached_results, ...checked_results ].map( result => [ result.name, result ] )
    )
    const results = selected_agents.map( candidate => results_by_name.get( candidate.name ) )

    return {
        results,
        skipped: checked_batch.skipped,
        cache_context: cache_contexts[ agent.name ] || null,
        cache_contexts,
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

    // Explicit `babysit <agent> resume <id>` can receive either an agent-native
    // id or a Babysit metadata id. When the id maps to stored metadata, restore
    // the original workspace before loading babysit.yaml and before hashing
    // workspace-scoped Docker state volumes.
    const stored_resume_session = cmd.metadata_resolved
        ? null
        : resolve_stored_agent_resume_session( cmd, agent )
    if( stored_resume_session?.agent_mismatch ) {
        log.error( `Session ${ cmd.session_id } belongs to ${ stored_resume_session.agent_mismatch }, not ${ agent.name }` )
        process.exit( 1 )
    }

    if( stored_resume_session?.pwd && existsSync( stored_resume_session.pwd ) ) {
        log.debug( `Restoring cwd: ${ stored_resume_session.pwd }` )
        process.chdir( stored_resume_session.pwd )
    } else if( stored_resume_session?.pwd ) {
        log.warn( `Original session pwd no longer exists: ${ stored_resume_session.pwd }` )
    }

    // A resumed session keeps its human-readable label unless the user gives
    // it a new one explicitly. Agent-less resumes carry the stored name in
    // flags; explicit-agent resumes reach it through stored metadata here.
    const session_display_name = resolve_session_display_name( flags, stored_resume_session )

    ensure_dirs()
    const protected_session_credential_paths = list_stored_sessions()
        .flatMap( session => [
            session.creds_tmpfile,
            ...Object.values( session.creds_tmpfiles || {} ),
        ] )
        .map( private_credential_tmpdir )
        .filter( Boolean )
    const protected_recovery_paths = list_credential_recoveries()
        .flatMap( recovery => recovery.sync_paths )
    cleanup_stale_ephemeral_credential_mounts( {
        protected_paths: [
            ...protected_session_credential_paths,
            ...protected_recovery_paths,
        ],
    } )

    // Build mode descriptor
    const mode = {
        yolo: flags.yolo,
        sandbox: flags.sandbox,
        mudbox: flags.mudbox,
        docker: flags.docker,
        ignore_host_agents_md: should_ignore_host_agent_context( flags, stored_resume_session ),
    }

    const docker_socket_path = mode.docker ? resolve_docker_socket_path() : null
    if( mode.docker && !docker_socket_path ) {
        log.error( `--docker requested, but no local Docker socket is available on the host.` )
        log.error( `Checked ${ DEFAULT_DOCKER_SOCKET }, Docker Desktop's macOS user socket, DOCKER_HOST, and the active Docker context.` )
        process.exit( 1 )
    }

    const docker_status = time_phase_sync( `docker daemon`, docker_daemon_status )
    if( !docker_status.available ) {
        print_error( `Docker is not running or is not reachable.` )
        if( docker_status.reason ) print_error( docker_status.reason )
        print_error( `Start Docker and try again.` )
        process.exit( 1 )
    }

    // Confirmed Watchtower releases either honor Babysit's opt-out label or
    // require explicit targets. Warn loudly when a similarly named daemon has
    // not been confirmed safe, before credentials or session state are created.
    time_phase_sync( `watchtower inspection`, warn_if_unrecognized_watchtower_is_running )

    if( should_confirm_docker_restricted_mode( mode ) ) {
        const confirmed = await confirm_docker_restricted_mode( mode )
        if( !confirmed ) {
            log.error( `Aborted --docker ${ mode.sandbox ? `--sandbox` : `--mudbox` } session.` )
            process.exit( 1 )
        }
    }

    const workspace = process.cwd()

    // Serialize before capture. A waiting launch then observes any refresh
    // token reconciled by the leader and reuses its warm verification instead
    // of racing the same one-use credential through another model request.
    const auth_lease = await time_phase( `authentication lease`, acquire_host_auth_lease )
    let credential_setup = null
    let foreground_recovery_id = null
    let startup_auth = null

    try {
        // The real session still receives credentials for every supported
        // agent so nested coding-agent calls remain authenticated.
        credential_setup = await time_phase(
            `credential discovery and preflight`,
            () => setup_credentials( agent )
        )
        foreground_recovery_id = register_credential_recovery( {
            sync_paths: Object.values( credential_setup.tmpfiles ).map(
                file => private_credential_tmpdir( file ) || file
            ),
        } )
        startup_auth = await time_phase( `authentication`, () => check_startup_agent_authentication( agent, {
            workspace,
            mode,
            creds_mounts: credential_setup.mounts,
            reconcile_credentials: name => credential_setup.sync?.flush?.( name ),
            credential_source_changed: name => credential_setup.sync?.source_changed?.( name ) === true,
            agent_args: passthrough,
        } ) )
    } catch ( error ) {
        if( credential_setup ) {
            await cleanup_failed_launch_credentials( {
                creds_sync: credential_setup.sync,
                recovery_id: foreground_recovery_id,
                context: `authentication setup failure`,
            } )
        }
        throw error
    } finally {
        auth_lease.release()
    }

    const {
        mounts: creds_mounts,
        sync: creds_sync,
        sync_baseline: creds_sync_baseline,
        sync_baselines: creds_sync_baselines,
        tmpfiles: creds_tmpfiles,
    } = credential_setup
    const {
        results: auth_results,
        skipped: startup_auth_skipped,
        cache_context: startup_auth_cache_context,
        cache_contexts: startup_auth_cache_contexts,
    } = startup_auth
    let auth_cache_context = startup_auth_cache_context
    let auth_cache_contexts = startup_auth_cache_contexts

    const unauthenticated_agents = unauthenticated_agent_names( auth_results )
    const failed_agents = failed_agent_names( auth_results )
    if( should_confirm_startup_authentication( auth_results, startup_auth_skipped ) ) {
        auth_results
            .filter( result => [ `unauthenticated`, `failed` ].includes( result.status ) )
            .forEach( result => log.debug( `Auth check failed for ${ result.name }: ${ result.reason || `unknown reason` }` ) )

        const should_continue = await confirm_continue_with_unauthenticated_agents( unauthenticated_agents, {
            failed_names: failed_agents,
        } )

        if( !should_continue ) {
            await cleanup_failed_launch_credentials( {
                creds_sync,
                recovery_id: foreground_recovery_id,
                context: `authentication abort`,
            } )
            log.error( `Aborted because host agent authentication is incomplete.` )
            process.exit( 1 )
        }
    }

    // Load babysit.yaml (creates default if missing). New config files get
    // the generated mode-aware launch prompt written into config.initial_prompt;
    // legacy configs that omit the field receive the same prompt as a fallback.
    const { config, rules } = load_config( workspace, {
        default_initial_prompt: build_system_prompt( mode ),
    } )

    // Compute the modifier list for the statusline + session metadata
    const modifiers = Object.entries( mode )
        .filter( ( [ , value ] ) => value )
        .map( ( [ key ] ) => key === `ignore_host_agents_md` ? `ignore-host-agents-md` : key )
    if( flags.loop ) modifiers.push( `loop` )

    // Initialize the loop deadline file before docker mounts it.
    // "idle" tells the statusline there's no active countdown yet.
    write_loop_deadline( `idle` )

    // Apply loop override if --loop flag is set. The detached monitor will
    // re-apply this when it boots, but doing it here too is harmless and
    // keeps the rules object internally consistent during the foreground.
    if( flags.loop ) apply_loop( rules, workspace, {
        include_global_loop: !mode.ignore_host_agents_md,
    } )

    // Build the launch prompt that babysit types into the agent's TUI.
    // Null or an empty string intentionally disables startup typing.
    const initial_prompt = should_send_initial_prompt( cmd ) ? resolve_initial_prompt( config ) : ``

    // Get agent-specific extra env
    const extra_env = agent.extra_env ? agent.extra_env( mode ) : {}

    // Handle resume by injecting the resume flag
    const agent_args = [ ...passthrough ]
    if( cmd.verb === `resume` ) {
        const resume_target = resolve_agent_resume_target( cmd, agent )

        if( resume_target.agent_mismatch ) {
            log.error( `Session ${ cmd.session_id } belongs to ${ resume_target.agent_mismatch }, not ${ agent.name }` )
            process.exit( 1 )
        }

        if( resume_target.resume_latest && agent.flags.resume_latest ) {
            const resume_flag = agent.flags.resume_latest()
            if( Array.isArray( resume_flag ) ) agent_args.unshift( ...resume_flag )
            else agent_args.unshift( resume_flag )
        } else if( resume_target.session_id && agent.flags.resume ) {
            const resume_flag = agent.flags.resume( resume_target.session_id )
            if( Array.isArray( resume_flag ) ) agent_args.unshift( ...resume_flag )
            else agent_args.unshift( resume_flag )
        }
    }

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
    const agent_exit_sentinel = randomUUID()
    const diagnostic_log_path = log_path || startup_diagnostic_log_path( session_name )

    // GitHub's isolated credential profile is uploaded through Docker's API to
    // a stopped container. The host file is removed only after `docker cp`
    // acknowledges it, before tmux starts the container.
    const github_cli_mounts = setup_github_cli_credentials( {
        include_host_preferences: !mode.ignore_host_agents_md,
    } )
    const all_creds_mounts = [ ...github_cli_mounts, ...creds_mounts ]

    let pipe_started = false

    let prepared_launch = null

    try {
        prepared_launch = await time_phase( `main container preparation`, () => prepare_docker_launch( {
            agent, workspace, mode,
            agent_args,
            creds_mounts: all_creds_mounts,
            config,
            extra_env,
            modifiers,
            ports: flags.ports || [],
            docker_socket_path,
            exit_sentinel: agent_exit_sentinel,
        } ) )

        // Connect before the tmux pane can start Docker. A very fast agent may
        // refresh and exit before await_started() observes a running state; the
        // failure cleanup still needs a transport for its final credential pull.
        if( creds_sync && prepared_launch.container_id ) {
            creds_sync.connect( prepared_launch.container_id )
        }

        const { pipe_started: started_pipe } = await time_phase( `tmux session creation`, () => create_session( session_name, prepared_launch.command, {
            log_path,
            startup_log_path: log_path ? null : diagnostic_log_path,
        } ) )
        pipe_started = started_pipe

        if( !await time_phase( `main container start`, () => prepared_launch.await_started() ) ) {
            throw new Error( `Docker container did not reach a running state after launch` )
        }

        if( pipe_started && log_path ) log.info( `Logging tmux output to ${ log_path }` )
        else if( pipe_started ) log.debug( `Capturing startup diagnostics to ${ diagnostic_log_path }` )

        if( initial_prompt ) {
            const readiness_timeout_ms = resolve_initial_prompt_ready_timeout( agent )
            log.info( `Waiting up to ${ readiness_timeout_ms / 1_000 }s for ${ agent.name } to accept the initial prompt` )
            const prompt_ready = await time_phase(
                `tui readiness`,
                () => wait_for_initial_prompt_ready( session_name, agent, {
                    timeout_ms: readiness_timeout_ms,
                } )
            )
            if( prompt_ready ) {
                log.info( `Sending initial prompt` )
                await send_text( session_name, initial_prompt )
            } else {
                log.warn( `Skipped initial prompt because ${ agent.name } did not reach its ready screen.` )
            }
        }

        // Give very fast Docker/container failures a chance to close the tmux
        // session before we save resumable metadata. Without this, tmux attach
        // can print only "no sessions" while the Docker error disappears.
        await wait( STARTUP_EXIT_GRACE_MS )
    } catch ( e ) {
        await cleanup_failed_launch_credentials( {
            creds_sync,
            prepared_launch,
            recovery_id: foreground_recovery_id,
            context: `launch failure`,
        } )
        throw e
    }

    if( !await has_session( session_name ) ) {
        report_startup_failure( agent, diagnostic_log_path )
        await cleanup_failed_launch_credentials( {
            creds_sync,
            prepared_launch,
            recovery_id: foreground_recovery_id,
            context: `startup failure`,
        } )
        if( !log_path ) remove_startup_diagnostic_log( diagnostic_log_path )
        process.exit( 1 )
    }

    let babysit_id
    let session_data

    try {
        await stop_startup_diagnostics( session_name, {
            uses_user_log: Boolean( log_path ),
            pipe_started,
            diagnostic_log_path,
        } )

        // End the foreground controller before the monitor starts. Awaiting its
        // final pull gives the two processes an exclusive handoff instead of
        // letting independent Docker-copy queues race on the same sync files.
        // Persist the resulting hashes so the monitor recognises the refreshed
        // host/tmpfile pair as its starting point.
        let monitor_sync_baselines = creds_sync_baselines
        if( creds_sync ) {
            await creds_sync.stop()
            monitor_sync_baselines = {
                ...creds_sync_baselines,
                ...creds_sync.baselines(),
            }

            auth_cache_contexts = Object.fromEntries(
                Object.entries( auth_cache_contexts ).flatMap( ( [ name, context ] ) => {
                    if( creds_sync.source_changed?.( name ) ) {
                        clear_host_auth_cache( name, {
                            expected_credential_fingerprint: context.credential_fingerprint,
                            image_identity: context.image_identity,
                        } )
                        return []
                    }

                    const refreshed_identity = refresh_file_credential_parts(
                        context.credential_parts,
                        creds_tmpfiles[ name ]
                    )
                    const refreshed = refreshed_identity && refresh_host_auth_cache( name, {
                        expected_credential_fingerprint: context.credential_fingerprint,
                        next_credential_fingerprint: refreshed_identity.fingerprint,
                        image_identity: context.image_identity,
                    } )

                    return [ [ name, refreshed ? {
                        ...context,
                        credential_fingerprint: refreshed_identity.fingerprint,
                        credential_parts: refreshed_identity.parts,
                    } : context ] ]
                } )
            )
            auth_cache_context = auth_cache_contexts[ agent.name ] || null
        }
        const monitor_sync_baseline = monitor_sync_baselines[ agent.name ]
            || creds_sync_baseline

        // Save durable ownership metadata before spawning the monitor. The
        // prepared launch keeps its signal/error cleanup until the detached
        // monitor process has acknowledged that it spawned successfully.
        babysit_id = generate_session_id()
        session_data = {
            babysit_id,
            name: session_display_name,
            agent: agent.name,
            agent_session_id: null,
            tmux_session: session_name,
            pwd: workspace,
            modifiers,
            ports: flags.ports || [],
            creds_tmpfile: creds_tmpfiles[ agent.name ] || null,
            creds_tmpfiles,
            creds_sync_baseline: monitor_sync_baseline,
            creds_sync_baselines: monitor_sync_baselines,
            auth_cache_context,
            auth_cache_contexts,
            agent_exit_sentinel,
            container_id: prepared_launch.container_id,
            started_at: new Date().toISOString(),
        }
        save_session( session_data )
        clear_credential_recovery( foreground_recovery_id )

        await time_phase( `monitor handoff`, () => spawn_monitor_daemon( babysit_id ) )
        prepared_launch.handoff()
    } catch ( error ) {
        await cleanup_failed_launch_credentials( {
            creds_sync,
            prepared_launch,
            recovery_id: foreground_recovery_id,
            context: `monitor handoff failure`,
        } )
        throw error
    }

    log.info( `Session started: ${ agent.name } (${ babysit_id })` )

    // Hand the user's terminal over to tmux. Blocks until they detach
    // (Ctrl+B d) or the agent exits and the session terminates.
    log.info( `Attaching to tmux session: ${ session_name }` )
    try {
        time_phase_sync( `foreground tmux attach`, () => execSync(
            `tmux -L ${ TMUX_SOCKET } attach -t ${ JSON.stringify( session_name ) }`,
            { stdio: `inherit` }
        ) )
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
const spawn_monitor_daemon = ( babysit_id ) => new Promise( ( resolve_spawn, reject_spawn ) => {

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

    const handle_error = error => reject_spawn( error )
    child.once( `error`, handle_error )
    child.once( `spawn`, () => {
        child.removeListener( `error`, handle_error )
        child.on( `error`, error => log.debug( `Monitor daemon error: ${ error.message }` ) )
        child.unref()
        log.debug( `Monitor daemon spawned (pid ${ child.pid })` )
        resolve_spawn( child.pid )
    } )

} )
