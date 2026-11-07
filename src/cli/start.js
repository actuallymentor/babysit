import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from 'fs'
import { join, relative, resolve } from 'path'
import { createInterface } from 'readline/promises'
import { wait } from 'mentie'

import { log, print_error } from '../utils/log.js'
import { CLONES_DIR, BABYSIT_DIR, ensure_dirs, TMUX_SOCKET } from '../utils/paths.js'
import { get_agent, has_accounts, retired_agent_message } from '../agents/index.js'
import { config_flags, load_config, load_clone_config } from '../babysit/yaml.js'
import {
    cleanup_stale_ephemeral_credential_mounts,
    credential_state_tmpfiles,
    session_credential_states,
    setup_credentials,
} from '../credentials/index.js'
import { read_sync_state, write_sync_state } from '../credentials/refresh.js'
import {
    clear_credential_recovery,
    list_credential_recoveries,
    register_credential_recovery,
} from '../credentials/recovery.js'
import { setup_github_cli_credentials } from '../credentials/github.js'
import { resolve_claude_login } from './claude_accounts.js'
import { private_credential_tmpdir, build_private_tmpfile } from '../utils/tmpfile.js'
import {
    DEFAULT_DOCKER_SOCKET,
    docker_daemon_status,
    resolve_docker_socket_path,
    shell_quote,
} from '../docker/run.js'
import { prepare_docker_launch } from '../docker/launch.js'
import {
    inspect_docker_container_state,
    remove_docker_container,
    stop_docker_container,
} from '../docker/file_transport.js'
import { warn_if_unrecognized_watchtower_is_running } from '../docker/watchtower.js'
import { image_facts } from '../docker/facts.js'
import { build_system_prompt } from '../modes/prompt.js'
import { clone as clone_prompt } from '../system_prompt/index.js'
import { confirm_continue_with_unauthenticated_agents } from '../agents/auth.js'
import { launch_auth_cache_contexts, local_auth_state } from '../agents/auth_gate.js'
import { acquire_host_auth_lease } from '../agents/auth_lease.js'
import { start_startup_status } from './startup_status.js'
import { apply_loop } from '../modes/loop.js'
import { attach_session, create_session, make_session_name, has_session, list_sessions } from '../tmux/session.js'
import { send_text } from '../tmux/send.js'
import { capture_pane, stop_pipe_pane } from '../tmux/capture.js'
import {
    save_session,
    load_session,
    list_stored_sessions,
    generate_session_id,
    session_original_workspace,
    session_workspace,
    update_session,
    fork_lineage,
} from '../sessions/store.js'
import { write_loop_deadline } from '../statusline/render.js'
import { resolve_log_path, append_session_header } from '../utils/log_file.js'
import { strip_ansi } from '../babysit/matcher.js'
import { time_phase, time_phase_sync } from '../utils/timing.js'
import { acquire_clone_lock, grant_clone_source_access, prepare_clone_workspace } from '../clone.js'
import { cmd_resume, resolve_numbered_resume } from './resume.js'
import { cmd_open } from './open.js'
import { cmd_monitor, refresh_session_auth_cache } from './monitor.js'
import { is_monitor_alive } from './monitor_process.js'
import { format_session_status_label } from './list.js'
import { modifiers_from_flags } from './registry.js'
import { acquire_session_lock, get_boot_id, get_process_identity } from '../sessions/lock.js'
import { session_lock_key, recovery_arguments, workspace_config_hash, docker_identity, container_image } from '../sessions/recovery.js'
import { create_launch_channel } from '../sessions/launch_channel.js'
import { get_session_pane } from '../tmux/session.js'

const INITIAL_PROMPT_READY_TIMEOUT_MS = 60_000
const INITIAL_PROMPT_READY_INTERVAL_MS = 250
const STARTUP_EXIT_GRACE_MS = 750
const STARTUP_LOG_TAIL_LINES = 80
const monotonic_now = () => performance.now()

// A Claude launch without a setup-token or another configured route
export const MISSING_CLAUDE_LOGIN = [
    `Claude needs a setup-token to run in Babysit (the host /login is not staged into containers).`,
    `  Mint one with claude setup-token (on any machine), then import it:`,
    `    babysit auth init --claude-token                    # paste interactively`,
    `    echo "$TOKEN" | babysit auth init --claude-token --token-stdin [--name NAME]`,
    `  An ANTHROPIC_API_KEY, Bedrock, Vertex or Foundry route in ~/.babysitrc works too.`,
].join( `\n` )

/**
 * Canonicalize an existing workspace while retaining a stable fallback for
 * legacy or temporarily unavailable session paths.
 * @param {string} path - Workspace path
 * @returns {string} Canonical absolute path
 */
export const canonical_workspace = path => {

    try {
        return realpathSync.native( path )
    } catch {
        return resolve( path )
    }

}

/**
 * Classify live sessions associated with an original host workspace.
 * @param {string} original_workspace - Canonical original workspace
 * @param {Object[]} tmux_sessions - Live Babysit tmux sessions
 * @param {Object[]} stored_sessions - Durable Babysit session metadata
 * @returns {{ clones: Object[], direct: Object[] }} Active clone/direct records
 */
export const active_sessions_for_original = ( original_workspace, tmux_sessions, stored_sessions ) => {

    const active_names = new Set( tmux_sessions.map( session => session.name ) )
    const matches = stored_sessions.filter( session => {
        const original = session_original_workspace( session )
        return original
            && active_names.has( session.tmux_session )
            && canonical_workspace( original ) === original_workspace
    } )

    return {
        clones: matches.filter( session => session.clone_path || session.modifiers?.includes( `clone` ) ),
        direct: matches.filter( session => !session.clone_path && !session.modifiers?.includes( `clone` ) ),
    }

}

/**
 * Parse a default-yes safety answer.
 * @param {string} answer - User-entered answer
 * @returns {boolean} Whether the user chose to continue
 */
export const allows_default_yes = ( answer = `` ) => /^(?:y(?:es)?)?$/i.test( answer.trim() )

/**
 * Ask a default-yes question while failing closed when stdin is non-interactive.
 * @param {string} question - Prompt ending in [Y/n]
 * @param {Object} [io]
 * @param {NodeJS.ReadableStream} [io.input=process.stdin] - Prompt input
 * @param {NodeJS.WritableStream} [io.output=process.stdout] - Prompt output
 * @returns {Promise<boolean>} Whether the user chose to continue
 */
export const confirm_default_yes = async ( question, {
    input = process.stdin,
    output = process.stdout,
} = {} ) => {

    if( !input.isTTY ) {
        log.error( `Cannot confirm safety on non-interactive stdin; pass --yes to continue.` )
        return false
    }

    const rl = createInterface( { input, output } )
    try {
        return allows_default_yes( await rl.question( question ) )
    } finally {
        rl.close()
    }

}

const CLONE_ACCESS_LIST_LIMIT = 20

// Each round can reveal paths hidden inside a directory it just opened.
const CLONE_ACCESS_MAX_ROUNDS = 10

const mode_string = ( { directory, mode } ) => `${ directory ? `d` : `-` }${ [ 6, 3, 0 ]
    .map( shift => mode >> shift & 7 )
    .map( bits => `${ bits & 4 ? `r` : `-` }${ bits & 2 ? `w` : `-` }${ bits & 1 ? `x` : `-` }` )
    .join( `` ) }`

/**
 * Describe paths the clone audit could not read, with the exact fix command.
 * @param {Object} error - CLONE_SOURCE_UNREADABLE error from prepare_clone_workspace
 * @returns {{ report: string, command: string|null }} Human report and owner-bit chmod, when one applies
 */
export const format_clone_access_report = ( { source, entries } ) => {

    const shown = entries.slice( 0, CLONE_ACCESS_LIST_LIMIT ).map( entry => {
        const name = relative( source, entry.path ) || `.`
        const why = !entry.bits
            ? `owned by uid ${ entry.uid }; fix as that user or with sudo`
            : entry.directory && entry.bits.includes( `x` )
                ? `directory cannot be entered (no owner x)`
                : `cannot be read (no owner r)`
        return `  ${ mode_string( entry ) }  ${ name }  — ${ why }`
    } )
    if( entries.length > shown.length ) shown.push( `  …and ${ entries.length - shown.length } more` )

    const fixable = entries.filter( entry => entry.bits )
    const by_bits = Object.groupBy( fixable, entry => entry.bits )
    const command = !fixable.length ? null
        : fixable.length <= CLONE_ACCESS_LIST_LIMIT
            ? Object.entries( by_bits ).map( ( [ bits, group ] ) => `chmod u+${ bits } ${ group.map( entry => shell_quote( entry.path ) ).join( ` ` ) }` ).join( ` && ` )
            : [
                `find ${ shell_quote( source ) } -user "$(id -u)" -type d ! -perm -u+rx -exec chmod u+rx {} +`,
                `find ${ shell_quote( source ) } -user "$(id -u)" -type f ! -perm -u+r -exec chmod u+r {} +`,
            ].join( ` && ` )

    const uid = typeof process.getuid === `function` ? ` as uid ${ process.getuid() }` : ``
    const report = [
        `Clone cannot copy ${ entries.length } path(s) from ${ source }${ uid }:`,
        ...shown,
        ...command ? [ `Fix:`, `  ${ command }` ] : [],
    ].join( `\n` )

    return { report, command }

}

/**
 * Prepare a clone; when the source audit finds paths the current user cannot
 * read, show the chmod that fixes them, offer to run it, then retry. Only
 * adds owner r/x on paths this user owns; never runs sudo.
 * @param {Object} options - prepare_clone_workspace options
 * @param {Object} [io]
 * @param {boolean} [io.assume_yes=false] - Apply the fix without asking (--yes)
 * @param {Function} [io.prepare] - Clone preparer, injected by tests
 * @param {Function} [io.confirm] - Default-yes question, injected by tests
 * @param {Function} [io.grant] - Owner-bit chmod, injected by tests
 * @returns {Promise<Object>} prepare_clone_workspace result
 */
export const prepare_clone_with_access_fix = async ( options, {
    assume_yes = false,
    prepare = prepare_clone_workspace,
    confirm = confirm_default_yes,
    grant = grant_clone_source_access,
} = {} ) => {

    const granted = new Set()
    let rounds = 0

    while( true ) {
        try {
            return prepare( options )
        } catch ( error ) {
            if( error.code !== `CLONE_SOURCE_UNREADABLE` ) throw error

            const { report } = format_clone_access_report( error )
            log.error( report )

            // A path that is still unreadable after chmod means the filesystem ignores modes.
            if( error.entries.some( entry => granted.has( entry.path ) ) ) {
                log.error( `chmod did not take effect; this filesystem may not honour Unix permissions.` )
                throw new Error( `Clone aborted; fix the permissions above and retry.` )
            }
            if( !error.fixable ) throw new Error( `Clone aborted; fix the permissions above and retry.` )
            if( granted.size && ++rounds >= CLONE_ACCESS_MAX_ROUNDS ) {
                throw new Error( `Clone aborted after ${ rounds } permission fixes; run the chmod above and retry.` )
            }

            const confirmed = assume_yes || await confirm( `Run this chmod now and retry the clone? [Y/n] ` )
            if( !confirmed ) throw new Error( `Clone aborted; run the chmod above and retry.` )

            const changed = grant( error.entries )
            error.entries.forEach( entry => granted.add( entry.path ) )
            log.info( `Granted owner access to ${ changed } path(s); retrying clone` )
        }
    }

}

/**
 * Finalize a container left behind when tmux or the host stopped abruptly.
 * Credential recovery reuses the normal monitor cleanup before relaunch.
 * @param {Object} session - Stored clone session
 * @param {Object} [dependencies] - Injectable recovery seams
 * @param {Function} [dependencies.inspect_container] - Docker state reader
 * @param {Function} [dependencies.remove_container] - Docker container remover
 * @param {Function} [dependencies.stop_container] - Docker container stopper
 * @param {Function} [dependencies.recover_session] - Credential-safe finalizer
 * @param {Function} [dependencies.update_session_fn] - Session record updater
 * @param {Function} [dependencies.monitor_alive] - Token-aware monitor probe
 * @param {Object} [dependencies.state_options] - Credential state directory seam
 * @returns {Promise<boolean>} Whether a surviving container was reconciled
 */
export const recover_clone_container = async ( session = {}, {
    inspect_container = inspect_docker_container_state,
    remove_container = remove_docker_container,
    stop_container = stop_docker_container,
    recover_session = cmd_monitor,
    update_session_fn = update_session,
    monitor_alive = is_monitor_alive,
    state_options = {},
} = {} ) => {

    const container = session.container_id || session.container_name
    const state = await inspect_container( container )
    if( !state ) return false

    if( monitor_alive( session.monitor_pid, session.monitor_token, { boot_id: session.boot_id } ) ) {
        throw new Error( `Session cleanup is still running for ${ session.babysit_id }; retry shortly.` )
    }

    log.warn( `Recovering ${ state } Docker container from the previous clone launch.` )
    if( session.credentials_cleaned ) {
        await remove_container( container )
        update_session_fn( session.babysit_id, { container_cleaned: true } )
        return true
    }

    if( [ `running`, `paused`, `restarting` ].includes( state ) ) {
        await stop_container( container )
    }

    // /tmp is commonly cleared at boot; the sync states under BABYSIT_DIR are
    // not. Recreate only the observation files, in fresh private directories,
    // and keep the states' hashes for conflict resolution.
    const states = session_credential_states( session, state_options )
    if( !session.creds_states && Object.keys( states ).length ) update_session_fn( session.babysit_id, { creds_states: states } )
    for( const [ name, path ] of Object.entries( states ) ) {
        const state = read_sync_state( path )
        if( !state ) throw new Error( `Cannot reconstruct missing credential sync state for ${ name }` )
        if( existsSync( state.tmpfile ) ) continue
        if( !state.source_hash || !state.synced_hash ) throw new Error( `Cannot reconstruct missing credential baseline for ${ name }` )
        const transport = build_private_tmpfile( `creds-${ name }`, `recovered.json`, ``, { file_mode: 0o666 } )
        if( !transport ) throw new Error( `Cannot rebuild credential observation file for ${ name }` )
        write_sync_state( path, { ...state, tmpfile: transport.file } )
    }

    update_session_fn( session.babysit_id, { container_id: container } )
    await recover_session( {
        session_id: session.babysit_id,
        monitor_token: session.monitor_token || null,
        cleanup_only: true,
    } )
    return true

}

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
 * Clone safety is mandatory because /original stays writable for deliberate
 * merge-back work. Existing custom or empty prompts still receive the guard.
 * @param {string} prompt - Configured launch prompt
 * @param {Object} mode - Active launch mode
 * @returns {string} Prompt with clone safety instructions when required
 */
export const ensure_clone_safety_prompt = ( prompt, mode = {} ) => {

    if( !mode.clone || prompt.includes( clone_prompt ) ) return prompt
    return [ prompt, clone_prompt ].filter( Boolean ).join( `\n\n` )

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

/** Merge launch progress without overwriting concurrent closure or shutdown intent. */
export const record_launch_progress = ( id, fields, { recovering = false, update = update_session } = {} ) =>
    update( id, current => ( {
        ...fields,
        expected_open: current.expected_open && ( fields.status !== `failed` || recovering || Boolean( current.shutdown_boot_id ) ),
        shutdown_boot_id: current.shutdown_boot_id,
    } ) )

/**
 * Start a new babysit session
 * @param {Object} cmd - Parsed command { agent, flags, passthrough }
 */
export const cmd_start = async ( cmd, {
    load_session_fn = load_session,
    list_stored_sessions_fn = list_stored_sessions,
    get_cwd = process.cwd,
    acquire_lock = acquire_session_lock,
    resume = cmd_resume,
    start = start_session,
    open = cmd_open,
} = {} ) => {

    if( cmd.verb === `resume` ) cmd = resolve_numbered_resume( cmd, { list_stored_sessions_fn, get_cwd } )

    const stored = cmd.stored_session || resolve_stored_agent_resume_session( cmd, get_agent( cmd.agent ) || {}, load_session_fn )
    const retired = retired_agent_message( cmd.agent ) || retired_agent_message( stored?.agent ) || retired_agent_message( stored?.agent_mismatch )
    if( retired ) throw new Error( retired )
    const release = cmd.lifecycle_locked ? () => {} : acquire_lock( stored ? session_lock_key( stored ) : `launch:${ randomUUID() }` )
    let released = false
    const handoff = () => {
        if( !released ) release()
        released = true
    }
    const launch = { ...cmd, on_handoff: handoff }
    try {
        // Re-read aliases under the same workspace lock used by recovery. A
        // concurrent resume may have replaced the launch since CLI lookup.
        if( stored && !cmd.recovering ) {
            if( stored.agent_mismatch ) throw new Error( `Session ${ cmd.session_id } belongs to ${ stored.agent_mismatch }, not ${ cmd.agent }` )
            return await resume( { ...cmd, session_id: stored.babysit_id, flags: cmd.flags }, {
                load_session_fn,
                start: async resolved => {
                    Object.assign( launch, resolved )
                    return start( launch )
                },
                open_session: async target => {
                    handoff()
                    return open( target )
                },
            } )
        }
        if( stored && load_session_fn( stored.babysit_id )?.superseded_by ) throw new Error( `Recovery target was superseded: ${ stored.babysit_id }` )
        return await start( launch )
    } finally {
        launch.release_clone_lock?.()
        handoff()
    }

}

/**
 * The one failure path of a launch, from the saved record to monitor handoff.
 * Phases register what they own (sync controller, prepared container,
 * recovery marker, status line); `fail()` tears it down once. A failed final
 * credential flush retains the stopped container and the private sync copies
 * and states (gotcha 81): they may hold the only rotated token.
 * @param {Object} options
 * @param {string} options.babysit_id - Saved session record
 * @param {boolean} [options.recovering] - Recovery launches keep expected_open
 * @param {Function|null} [options.release_clone_lock] - Clone workspace lock
 * @param {Function} [options.cleanup] - Credential/container teardown seam
 * @param {Function} [options.mark_failed] - Record status seam
 * @returns {Object} Transaction: owned resources plus `fail( error )`
 */
export const create_launch_transaction = ( {
    babysit_id,
    recovering = false,
    release_clone_lock = null,
    cleanup = cleanup_failed_launch_credentials,
    mark_failed = () => record_launch_progress( babysit_id, { status: `failed` }, { recovering } ),
} = {} ) => {

    const transaction = {
        release_clone_lock,
        context: `launch failure`,
        creds_sync: null,
        prepared_launch: null,
        recovery_id: null,
        startup_status: null,
        after_failure: [],
        failed: null,
    }

    transaction.fail = async () => {
        if( transaction.failed ) return transaction.failed
        transaction.failed = ( async () => {
            transaction.startup_status?.stop()
            const result = await cleanup( {
                creds_sync: transaction.creds_sync,
                prepared_launch: transaction.prepared_launch,
                recovery_id: transaction.recovery_id,
                context: transaction.context,
            } )
            transaction.after_failure.forEach( task => task() )
            mark_failed()
            release_clone_lock?.()
            return result
        } )()
        return transaction.failed
    }

    return transaction

}

/**
 * Phase 1: everything decided before any credential is touched (agent,
 * resume target, mode, Claude login, workspace/clone, launch identity),
 * ending with the saved `preparing` record so a power loss can recover it.
 * @param {Object} cmd - Parsed command
 * @returns {Promise<Object>} Launch context, with its failure transaction
 */
async function resolve_launch( cmd ) {

    const { agent: agent_name, flags, passthrough } = cmd

    // Resolve the agent adapter
    const agent = get_agent( agent_name )
    if( !agent ) {
        log.error( `Unknown agent: ${ agent_name }` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    // Explicit `babysit <agent> resume <id>` can receive either an agent-native
    // id or a Babysit metadata id. When the id maps to stored metadata, restore
    // the original workspace before loading babysit.yaml and before hashing
    // workspace-scoped Docker state volumes.
    const stored_resume_session = cmd.stored_session || (
        cmd.metadata_resolved
            ? null
            : resolve_stored_agent_resume_session( cmd, agent )
    )
    if( stored_resume_session?.agent_mismatch ) {
        log.error( `Session ${ cmd.session_id } belongs to ${ stored_resume_session.agent_mismatch }, not ${ agent.name }` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    if( stored_resume_session?.clone_pruned_at ) {
        log.error( `Clone workspace was pruned at ${ stored_resume_session.clone_pruned_at }: ${ stored_resume_session.clone_path }` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    const stored_is_clone = Boolean(
        stored_resume_session?.clone_path
        || stored_resume_session?.modifiers?.includes( `clone` )
    )
    if( flags.clone && stored_resume_session && !stored_is_clone ) {
        log.error( `--clone cannot be added while resuming a non-clone session; start a new clone session instead.` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    if( stored_resume_session && await has_session( stored_resume_session.tmux_session ) ) {
        log.error( `Clone session is already active: ${ stored_resume_session.babysit_id }` )
        log.error( `Attach with: babysit open ${ stored_resume_session.babysit_id }` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    // Tmux releases the user's terminal before credential finalization finishes.
    // A quick manual resume should wait for that handoff, not lose its parent.
    if( stored_resume_session && !cmd.container_reconciled ) {
        const deadline = Date.now() + 60_000
        while( true ) {
            const previous = load_session( stored_resume_session.babysit_id )
            if( !is_monitor_alive( previous?.monitor_pid, previous?.monitor_token, { boot_id: previous?.boot_id } ) ) break
            if( Date.now() >= deadline ) throw new Error( `Previous session cleanup is still running; retry shortly` )
            await wait( 250 )
        }
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
            ...Object.values( credential_state_tmpfiles( session.creds_states ) ),
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
        adb: flags.adb,
        ios: flags.ios,
        clone: Boolean( flags.clone || stored_is_clone ),
        ignore_host_agents_md: should_ignore_host_agent_context( flags, stored_resume_session ),
    }

    if( mode.clone && cmd.verb === `resume` && !stored_resume_session ) {
        log.error( `--clone resume requires a Babysit session ID so the existing clone can be restored.` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    if( mode.clone && ( process.env.BABYSIT_DOCKER === `1` || process.env.BABYSIT_HOST_WORKSPACE ) ) {
        log.error( `--clone is not supported from inside a Docker-enabled Babysit session.` )
        log.error( `Run the clone session from the Docker host so ${ CLONES_DIR } is host-visible.` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    const docker_socket_path = mode.docker ? resolve_docker_socket_path() : null
    if( mode.docker && !docker_socket_path ) {
        log.error( `--docker requested, but no local Docker socket is available on the host.` )
        log.error( `Checked ${ DEFAULT_DOCKER_SOCKET }, Docker Desktop's macOS user socket, DOCKER_HOST, and the active Docker context.` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    const docker_status = time_phase_sync( `docker daemon`, docker_daemon_status )
    if( !docker_status.available ) {
        print_error( `Docker is not running or is not reachable.` )
        if( docker_status.reason ) print_error( docker_status.reason )
        print_error( `Start Docker and try again.` )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    // Confirmed Watchtower releases either honor Babysit's opt-out label or
    // require explicit targets. Warn loudly when a similarly named daemon has
    // not been confirmed safe. `docker ps` can take seconds on a busy daemon,
    // so it runs alongside the launch and is awaited before tmux appears.
    const watchtower_check = time_phase( `watchtower inspection`, warn_if_unrecognized_watchtower_is_running, { slow_ms: Infinity } )

    // Start the image inspect now so it overlaps credential and account work
    image_facts()

    // A directory launch already showed this warning in its overview and was confirmed.
    if( should_confirm_docker_restricted_mode( mode ) && !cmd.recovering && !cmd.batch ) {
        const confirmed = await confirm_docker_restricted_mode( mode )
        if( !confirmed ) {
            log.error( `Aborted --docker ${ mode.sandbox ? `--sandbox` : `--mudbox` } session.` )
            throw new Error( `Session launch aborted; see diagnostic above` )
        }
    }

    // Claude login for every session (Codex and OpenCode sessions too, for
    // nested claude): --account, else the resumed session's, else the one
    // with most headroom. Only Claude launches may wait on a quota probe;
    // others pick from cached readings. A setup-token is the only
    // subscription login staged; an API key/Bedrock/Vertex/Foundry route
    // configured on the host stays the login as is.
    const claude_login = await time_phase( `claude account selection`, () => resolve_claude_login( {
        requested: flags.account,
        // A fork keeps its parent's subscription
        stored: stored_resume_session?.claude_account || cmd.fork?.claude_account || null,
        probe_quota: has_accounts( agent ),
    } ) )
    const launch_account = claude_login.account
    if( launch_account ) log[ claude_login.reason === `single account` ? `debug` : `info` ]( `Claude account: ${ launch_account.name } (${ claude_login.reason })` )
    if( agent.name === `claude` && !launch_account && !claude_login.route ) {
        print_error( MISSING_CLAUDE_LOGIN )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

    // The token lives in Claude's credentials file, so a limit switches
    // subscriptions in place instead of restarting the session
    const claude_hot_swap = Boolean( launch_account )

    const launch_cwd = canonical_workspace( process.cwd() )
    const stored_original = session_original_workspace( stored_resume_session )
    const original_workspace = canonical_workspace( stored_original || launch_cwd )
    const original_exists = existsSync( original_workspace )
    let original_mount = original_exists ? original_workspace : null

    if( mode.clone && stored_resume_session && !original_exists ) {
        log.warn( `Original workspace no longer exists: ${ original_workspace }` )
        log.warn( `The saved clone can still resume, but /original will not be mounted.` )

        const confirmed = flags.yes || await confirm_default_yes( `Resume from the clone without /original? [Y/n] ` )
        if( !confirmed ) {
            log.error( `Aborted clone-only resume.` )
            throw new Error( `Session launch aborted; see diagnostic above` )
        }
    }

    if( !stored_resume_session ) {
        const active = active_sessions_for_original(
            original_workspace,
            await list_sessions(),
            list_stored_sessions()
        )

        if( active.clones.length ) {
            log.info( `This folder has ${ active.clones.length } agents working on clones` )
        }

        // A fork snapshot of a live parent is the point, not an accident
        if( mode.clone && active.direct.length && !cmd.fork ) {
            log.warn( `This folder has ${ active.direct.length } active agents working directly in it.` )
            log.warn( `Files may change while the clone is being copied.` )

            const confirmed = flags.yes || await confirm_default_yes( `Continue with --clone? [Y/n] ` )
            if( !confirmed ) {
                log.error( `Aborted clone session.` )
                throw new Error( `Session launch aborted; see diagnostic above` )
            }
        }
    }

    const babysit_id = generate_session_id()
    // A fork that shares its parent's clone joins that clone family
    const clone_id = cmd.fork?.join_clone_id
        || stored_resume_session?.clone_id
        || ( stored_is_clone ? stored_resume_session.babysit_id : null )
        || babysit_id
    let clone_branch = stored_resume_session?.clone_branch || null
    let clone_git_repository = stored_resume_session?.clone_git_repository || false
    let workspace = original_exists ? original_workspace : launch_cwd
    // An explicit --config wins; a resumed session keeps the file it launched with.
    const config_path = flags.config || stored_resume_session?.config_path || null

    if( mode.clone ) {
        if( stored_resume_session ) {
            const stored_clone_path = session_workspace( stored_resume_session )
            if( !stored_clone_path || !existsSync( stored_clone_path ) ) {
                throw new Error( `Saved clone workspace no longer exists: ${ stored_clone_path || `unknown` }` )
            }

            if( original_mount ) {
                const prepared_clone = await prepare_clone_with_access_fix( {
                    source: original_workspace,
                    clone_id,
                    name: stored_resume_session.name,
                }, { assume_yes: flags.yes } )
                if( prepared_clone.clone_path !== resolve( stored_clone_path ) ) {
                    throw new Error( `Stored clone path does not match clone ownership metadata: ${ stored_clone_path }` )
                }
                const {
                    workspace: prepared_workspace,
                    clone_branch: prepared_branch,
                    git_repository: prepared_git_repository,
                } = prepared_clone
                workspace = prepared_workspace
                clone_branch = prepared_branch
                clone_git_repository = prepared_git_repository
            } else {
                workspace = canonical_workspace( stored_clone_path )
            }
        } else if( cmd.fork?.join_clone_id ) {
            // Reuse only the existing, manifest-verified clone; never recreate it
            if( !existsSync( join( CLONES_DIR, clone_id ) ) ) throw new Error( `Parent clone ${ clone_id } no longer exists` )
            const prepared_clone = await prepare_clone_with_access_fix( {
                source: original_workspace,
                clone_id,
                name: session_display_name,
            }, { assume_yes: flags.yes } )
            if( !prepared_clone.reused ) throw new Error( `Parent clone ${ clone_id } no longer exists` )
            const {
                workspace: joined_workspace,
                clone_branch: joined_branch,
                git_repository: joined_git_repository,
            } = prepared_clone
            workspace = joined_workspace
            clone_branch = joined_branch
            clone_git_repository = joined_git_repository
        } else {
            // Clone options come from the source's babysit.yaml, read once at creation.
            const clone_config = load_clone_config( original_workspace, { config_path } )
            log.info( `${ clone_config.mode === `git` ? `Cloning` : `Copying` } ${ cmd.fork?.clone_options?.tree || original_workspace } into clone ${ clone_id }` )
            // A fork snapshots its parent's tree (maybe a clone) with every local change
            const prepared_clone = await prepare_clone_with_access_fix( {
                source: original_workspace,
                clone_id,
                name: session_display_name,
                clone_config,
                ...cmd.fork?.clone_options,
            }, { assume_yes: flags.yes } )
            const {
                workspace: prepared_workspace,
                clone_branch: prepared_branch,
                git_repository: prepared_git_repository,
                clone_mode,
            } = prepared_clone
            workspace = prepared_workspace
            clone_branch = prepared_branch
            clone_git_repository = prepared_git_repository
            log.info( `Clone ready (${ clone_mode }): ${ workspace }` )
            if( clone_branch ) log.info( `Clone branch: ${ clone_branch }` )
        }

        if( clone_git_repository ) {
            log.warn( `Clone preserves the original Git remotes; pushes still target those remotes.` )
        }
    }

    // babysit fork: chat state, handoff mounts and prompt need the final workspace
    const fork_launch = cmd.fork ? await cmd.fork.prepare( { workspace, mode, clone_branch } ) : null

    // Lifecycle identity is stable even when a tmux name is reused after reboot.
    const owner = await docker_identity( { id: docker_status.id } )
    const replay = recovery_arguments( agent, passthrough, mode )
    const release_clone_lock = mode.clone ? acquire_clone_lock( workspace ) : null
    cmd.release_clone_lock = release_clone_lock
    process.chdir( workspace )

    // Compute immutable launch identity before authentication or Docker create
    // so a power loss leaves enough metadata to recover the clone.
    const modifiers = modifiers_from_flags( { ...mode, loop: flags.loop } )

    const session_name = make_session_name( workspace, agent.name )
    const container_name = `babysit-${ babysit_id }`
    const monitor_token = randomUUID()
    const started_at = new Date().toISOString()
    const base_session_data = {
        babysit_id,
        config_path,
        name: session_display_name,
        agent: agent.name,
        agent_session_id: stored_resume_session?.agent_session_id || null,
        agent_session_id_source: stored_resume_session?.agent_session_id_source || null,
        recovery_native_id: cmd.recovering ? stored_resume_session?.agent_session_id : null,
        tmux_session: session_name,
        pwd: original_workspace,
        original_pwd: original_workspace,
        workspace,
        clone: mode.clone,
        // A read-only fork of a clone keeps its clone_id across resumes for prune
        clone_id: mode.clone ? clone_id : stored_resume_session?.clone_id || null,
        clone_path: mode.clone ? workspace : null,
        clone_branch,
        clone_git_repository,
        modifiers,
        monitor_token,
        ports: flags.ports || [],
        container_name,
        status: `preparing`,
        resumed_from: stored_resume_session?.babysit_id || null,
        // Fork lineage survives resumes so babysit list keeps nesting the fork
        ...fork_lineage( stored_resume_session ),
        started_at,
        boot_id: get_boot_id(),
        launch_owner: { pid: process.pid, process_identity: get_process_identity(), boot_id: get_boot_id(), hostname: owner.host },
        expected_open: true,
        recovery_version: 1,
        ...owner,
        tmux_socket: TMUX_SOCKET,
        image_id: stored_resume_session?.image_id || null,
        launch_spec: {
            args: replay.args, unsupported: replay.unsupported, log: flags.log,
            config_hash: stored_resume_session?.launch_spec?.config_hash || null,
            environment: Object.fromEntries( [ `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `OPENCODE_CONFIG_DIR` ]
                .filter( key => process.env[ key ] ).map( key => [ key, process.env[ key ] ] ) ),
        },
        // `restart --continue` (account auto-switch) nudges the agent like a recovery
        continuation: cmd.recovering ?  cmd.no_continue ? `skipped` : `pending`  : flags.continue_prompt ? `pending` : null,
        // Account fields only exist where accounts are in play
        ...launch_account && { claude_account: launch_account.name },
        ...claude_hot_swap && { claude_hot_swap: true },
        ...stored_resume_session?.account_switches?.length && { account_switches: stored_resume_session.account_switches },
        // forked_from, fork_base, fork_filesystem, fork_history, fork_handoff
        ...cmd.fork?.record,
    }
    save_session( base_session_data )
    if( stored_resume_session ) update_session( stored_resume_session.babysit_id, {
        superseded_by: babysit_id,
        expected_open: false,
    } )

    return {
        cmd, agent, flags, passthrough, mode,
        stored_resume_session, session_display_name,
        docker_socket_path, watchtower_check, claude_login,
        workspace, original_workspace, original_mount, config_path,
        fork_launch, modifiers,
        babysit_id, session_name, container_name, monitor_token,
        base_session_data,
        // The record exists from here on: every later failure goes through it
        transaction: create_launch_transaction( {
            babysit_id,
            recovering: cmd.recovering,
            release_clone_lock,
        } ),
    }

}

/**
 * Phase 2: capture every agent's login under the host auth lease, run the
 * local auth gate, and inherit fresh cache trust. No model call.
 * @param {Object} launch - resolve_launch context; gains `credentials` and auth cache contexts
 * @param {Object} [seams] - Lease, capture and gate seams
 */
export const acquire_credentials = async ( launch, {
    acquire_lease = acquire_host_auth_lease,
    setup = setup_credentials,
    register_recovery = register_credential_recovery,
    gate = local_auth_state,
    confirm = confirm_continue_with_unauthenticated_agents,
    cache_contexts = launch_auth_cache_contexts,
} = {} ) => {

    const { agent, cmd, transaction } = launch
    transaction.context = `credential setup failure`

    // Gotcha 94: lease BEFORE capture. A concurrent doctor/checker probe can
    // rotate a one-use refresh token while this launch copies it. One live
    // line names the blocking step so a slow host never looks hung.
    const { startup_status } = launch
    const auth_lease = await time_phase( `authentication lease`, () => acquire_lease( {
        on_wait: () => startup_status?.set( `waiting for another authentication check to finish` ),
    } ) )

    try {
        // The real session still receives credentials for every supported
        // agent so nested coding-agent calls remain authenticated.
        startup_status?.set( `loading credentials` )
        const credentials = await time_phase( `credential discovery`, () => setup( agent ) )
        transaction.creds_sync = credentials.sync
        // The Claude account rides along as a staged file that outranks the rc token
        credentials.mounts.push( ...launch.claude_login.mounts )
        // Gotcha 84: register ownership right after capture
        transaction.recovery_id = register_recovery( {
            sync_paths: Object.values( credentials.tmpfiles ).map( file => private_credential_tmpdir( file ) || file ),
        } )
        launch.credentials = credentials
    } finally {
        auth_lease.release()
    }

    // Local gate, no model call: only a login that is plainly missing stops
    // the launch. Real probes belong to doctor --auth and auth check.
    const { mounts } = launch.credentials
    const gate_state = gate( agent, mounts, { route: launch.claude_login.route } )
    if( gate_state === `missing` ) {
        startup_status?.pause()
        // Recovery and directory launches cannot stop to ask, so they skip the session.
        const proceed = !cmd.recovering && !cmd.batch && await confirm( [ agent.name ] )
        if( !proceed ) {
            transaction.context = `authentication abort`
            log.error( `Aborted: ${ agent.name } has no login to stage. Log in on the host, then retry.` )
            throw new Error( `Session launch aborted; see diagnostic above` )
        }
    } else log.debug( `Launch auth gate: ${ agent.name } ${ gate_state }` )

    // Inherit fresh verified cache entries so session rotations keep them warm
    launch.auth_cache_contexts = await time_phase( `authentication cache`, () => cache_contexts( agent, mounts, {
        workspace: launch.workspace,
        mode: launch.mode,
        agent_args: launch.passthrough,
    } ) )

}

/**
 * Phase 3: config, prompt, agent args, and the stopped (or gated) container.
 * @param {Object} launch - Context; gains config, prompt, log paths and `prepared_launch`
 */
const prepare_container = async launch => {

    const { agent, cmd, flags, mode, workspace, config_path, fork_launch, transaction, base_session_data } = launch
    transaction.context = `launch failure`

    // Load the workspace config (or the --config file). Configs that omit
    // initial_prompt receive the generated mode-aware launch prompt.
    const { config, rules } = load_config( workspace, {
        default_initial_prompt: build_system_prompt( mode ),
        config_path,
        source_dir: mode.clone ? launch.original_workspace : null,
    } )

    base_session_data.launch_spec.config_hash = workspace_config_hash( workspace, config_path )
    // The yaml's rules as list/watch FLAGS; --loop's rule is already the `loop` modifier
    update_session( launch.babysit_id, { launch_spec: base_session_data.launch_spec, config_flags: config_flags( rules, config_path ) } )

    // Initialize the loop deadline file before docker mounts it.
    // "idle" tells the statusline there's no active countdown yet.
    write_loop_deadline( `idle` )

    // Apply loop override if --loop flag is set. The detached monitor will
    // re-apply this when it boots, but doing it here too is harmless and
    // keeps the rules object internally consistent during the foreground.
    if( flags.loop ) apply_loop( rules, workspace, {
        include_global_loop: !mode.ignore_host_agents_md,
        config_path,
    } )

    // /original remains writable for deliberate merge-back work, so clone
    // safety cannot be disabled by a custom or empty configured prompt.
    const launch_prompt = should_send_initial_prompt( cmd )
        ? ensure_clone_safety_prompt( resolve_initial_prompt( config ), mode )
        : ``
    // A fork adds its notes; after a native fork they replace the launch prompt
    launch.initial_prompt = fork_launch ? fork_launch.prompt( launch_prompt ) : launch_prompt

    // Handle resume by injecting the resume flag
    const agent_args = [ ...launch.passthrough ]
    if( cmd.verb === `resume` ) {
        const resume_target = resolve_agent_resume_target( cmd, agent )

        if( resume_target.agent_mismatch ) {
            log.error( `Session ${ cmd.session_id } belongs to ${ resume_target.agent_mismatch }, not ${ agent.name }` )
            throw new Error( `Session launch aborted; see diagnostic above` )
        }

        const resume_flag = resume_target.resume_latest && agent.flags.resume_latest
            ? agent.flags.resume_latest()
            : resume_target.session_id && agent.flags.resume
                ? agent.flags.resume( resume_target.session_id )
                : []
        agent_args.unshift( ...[ resume_flag ].flat() )
    }

    // A native fork opens the parent's conversation as a new branch of it
    if( fork_launch?.agent_args?.length ) agent_args.unshift( ...fork_launch.agent_args )

    // Start tmux output logging if --log was passed. The header goes in BEFORE
    // the pane command runs, so each session block opens with a clean
    // "Babysit session start: ..." line.
    launch.log_path = null
    if( typeof flags.log === `string` ) {
        const candidate = resolve_log_path( flags.log, { cwd: workspace } )
        if( append_session_header( candidate ) ) launch.log_path = candidate
    }

    const agent_exit_sentinel = randomUUID()
    const completion_capture = {
        launch_id: agent_exit_sentinel,
        file: `/tmp/.babysit-completion-${ agent_exit_sentinel }/message.json`,
    }
    launch.diagnostic_log_path = launch.log_path || startup_diagnostic_log_path( launch.session_name )

    // GitHub's isolated credential profile is uploaded through Docker's API to
    // a stopped container. The host file is removed only after `docker cp`
    // acknowledges it, before tmux starts the container.
    const github_cli_mounts = setup_github_cli_credentials( {
        include_host_preferences: !mode.ignore_host_agents_md,
    } )
    // Fork handoff files ride the same pre-start upload as credentials
    const all_creds_mounts = [ ...github_cli_mounts, ...launch.credentials.mounts, ...fork_launch?.mounts || [] ]

    launch.startup_status?.set( `preparing container` )
    const prepared_launch = await time_phase( `main container preparation`, () => prepare_docker_launch( {
        agent, workspace, original_workspace: launch.original_mount, mode,
        agent_args,
        creds_mounts: all_creds_mounts,
        config,
        extra_env: agent.extra_env ? agent.extra_env( mode ) : {},
        modifiers: launch.modifiers,
        ports: flags.ports || [],
        docker_socket_path: launch.docker_socket_path,
        container_name: launch.container_name,
        exit_sentinel: agent_exit_sentinel,
        completion_capture,
        deferred_upload: true,
    } ) )
    transaction.prepared_launch = prepared_launch
    launch.prepared_launch = prepared_launch

    // Connect before the tmux pane can start Docker. A very fast agent may
    // refresh and exit before await_started() observes a running state; the
    // failure cleanup still needs a transport for its final credential pull.
    // With a deferred upload the agent is gated, so sync connects after the
    // files land (gotcha 57): a host re-login must not race the bootstrap archive.
    const { sync } = launch.credentials
    if( sync && prepared_launch.container_id && !prepared_launch.deferred ) sync.connect( prepared_launch.container_id )

    // Persist the container and capture identity before it can start work.
    Object.assign( base_session_data, {
        completion_capture,
        control_id: completion_capture.launch_id,
        agent_exit_sentinel,
        container_id: prepared_launch.container_id,
        image_id: await container_image( prepared_launch.container_id ),
    } )
    record_launch_progress( launch.babysit_id, base_session_data )

}

/**
 * Phase 4: tmux pane, container start, deferred credential upload, gate
 * release, and the initial prompt.
 * @param {Object} launch - Context; gains `pipe_started`
 */
const start_tmux_and_prompt = async launch => {

    const { agent, session_name, prepared_launch, log_path, diagnostic_log_path, transaction } = launch
    const { sync } = launch.credentials

    await launch.watchtower_check

    launch.startup_status?.set( `creating tmux session` )
    const { pipe_started } = await time_phase( `tmux session creation`, () => create_session( session_name, prepared_launch.command, {
        log_path,
        startup_log_path: log_path ? null : diagnostic_log_path,
        status_label: format_session_status_label( {
            name: launch.session_display_name,
            pwd: launch.original_workspace,
            modifiers: launch.modifiers,
        } ),
    } ) )
    launch.pipe_started = pipe_started

    launch.startup_status?.set( `waiting for the container to start` )
    if( !await time_phase( `main container start`, () => prepared_launch.await_started() ) ) {
        throw new Error( `Docker container did not reach a running state after launch` )
    }

    if( prepared_launch.deferred ) {
        launch.startup_status?.set( `uploading credentials` )
        await time_phase( `deferred credential upload`, () => prepared_launch.upload() )
        // Gotcha 57: sync must be live before the gate opens. If the release
        // exec loses its acknowledgement the agent may already be rotating
        // tokens, and failure cleanup pulls through this transport.
        if( sync ) sync.connect( prepared_launch.container_id )
        await time_phase( `bootstrap release`, () => prepared_launch.release() )
    }

    if( pipe_started && log_path ) log.info( `Logging tmux output to ${ log_path }` )
    else if( pipe_started ) log.debug( `Capturing startup diagnostics to ${ diagnostic_log_path }` )

    launch.startup_status?.stop()
    let prompt_ready = false
    if( launch.initial_prompt ) {
        const readiness_timeout_ms = resolve_initial_prompt_ready_timeout( agent )
        log.info( `Waiting up to ${ readiness_timeout_ms / 1_000 }s for ${ agent.name } to accept the initial prompt` )
        prompt_ready = await time_phase( `tui readiness`, () => wait_for_initial_prompt_ready( session_name, agent, {
            timeout_ms: readiness_timeout_ms,
        } ) )
        if( prompt_ready ) {
            log.info( `Sending initial prompt` )
            await send_text( session_name, launch.initial_prompt )
        } else {
            log.warn( `Skipped initial prompt because ${ agent.name } did not reach its ready screen.` )
        }
    }

    // Give very fast Docker/container failures a chance to close the tmux
    // session before we save resumable metadata. Without this, tmux attach
    // can print only "no sessions" while the Docker error disappears. A TUI
    // observed on screen already proves the container survived its boot.
    if( !prompt_ready ) await wait( STARTUP_EXIT_GRACE_MS )

    if( !await has_session( session_name ) ) {
        report_startup_failure( agent, diagnostic_log_path )
        transaction.context = `startup failure`
        if( !log_path ) transaction.after_failure.push( () => remove_startup_diagnostic_log( diagnostic_log_path ) )
        throw new Error( `Session launch aborted; see diagnostic above` )
    }

}

/**
 * Phase 5: final foreground flush, durable record, monitor spawn. Gotcha 84:
 * the foreground controller ends BEFORE the monitor starts, so two Docker-copy
 * queues never race on the same sync copies; the durable sync states carry
 * the resulting hashes across.
 * @param {Object} launch - Context
 * @returns {Promise<Object>} Saved session record
 */
const handoff_to_monitor = async launch => {

    const { agent, cmd, session_name, prepared_launch, base_session_data, babysit_id, transaction } = launch
    const { sync, states, tmpfiles } = launch.credentials
    transaction.context = `monitor handoff failure`

    await stop_startup_diagnostics( session_name, {
        uses_user_log: Boolean( launch.log_path ),
        pipe_started: launch.pipe_started,
        diagnostic_log_path: launch.diagnostic_log_path,
    } )

    const auth_cache_contexts = launch.auth_cache_contexts || {}
    if( sync ) {
        await sync.stop()
        // Same re-stamp the monitor runs after each rotation it pulls back
        refresh_session_auth_cache( { auth_cache_contexts }, agent, sync, tmpfiles )
    }

    // Save durable ownership metadata before spawning the monitor. The
    // prepared launch keeps its signal/error cleanup until the detached
    // monitor process has acknowledged that it spawned successfully.
    const launch_channel = create_launch_channel( base_session_data )
    try {
        const identity = await launch_channel.refresh()
        if( identity ) {
            if( cmd.recovering && identity.session_id !== base_session_data.recovery_native_id ) throw new Error( `Agent resumed a different conversation` )
            base_session_data.agent_session_id = identity.session_id
            base_session_data.agent_session_id_source = `structured`
        }
    } finally {
        launch_channel.close()
    }
    const pane = await get_session_pane( session_name )
    const session_data = record_launch_progress( babysit_id, {
        ...base_session_data,
        pane_id: pane.pane_id,
        // Durable sync states: the monitor resumes their hashes
        creds_states: states,
        auth_cache_context: auth_cache_contexts[ agent.name ] || null,
        auth_cache_contexts,
        container_id: prepared_launch.container_id,
        status: `active`,
    } )
    // The session record owns the sync paths now
    clear_credential_recovery( transaction.recovery_id )

    const monitor_pid = await time_phase( `monitor handoff`, () => spawn_monitor_daemon( babysit_id, launch.monitor_token ) )
    update_session( babysit_id, { monitor_pid } )
    session_data.monitor_pid = monitor_pid
    prepared_launch.handoff()
    launch.transaction.release_clone_lock?.()
    return session_data

}

/**
 * Hand the user's terminal to tmux, then say how to come back.
 * @param {Object} launch - Context
 * @param {Object} session_data - Saved session record
 */
const attach_foreground = async ( launch, session_data ) => {

    const { session_name, babysit_id } = launch

    // Blocks until they detach (Ctrl+B d) or the agent exits. Stays
    // in-process even under the shell-init wrapper (empty env): the
    // re-attach/resume hint below needs babysit alive after the detach.
    log.info( `Attaching to tmux session: ${ session_name }` )
    time_phase_sync( `foreground tmux attach`, () => attach_session( session_name, { env: {} } ), { slow_ms: Infinity } )

    // Print the command unquoted on its own line so a triple-click selects it.
    // The bare `babysit resume <id>` form looks the agent up from metadata.
    if( await has_session( session_name ) ) {
        console.log( `\nDetached. Re-attach with:\n\nbabysit open ${ babysit_id }\n` )
    } else {
        // Prefer the agent's own session id: its native --resume accepts it,
        // and load_session resolves either form back to the record.
        const final = load_session( babysit_id ) || session_data
        console.log( `\nTo resume this session, run:\nbabysit resume ${ final.agent_session_id || babysit_id }` )
    }

}

/**
 * Launch one session: resolve → acquire credentials → prepare container →
 * tmux + prompt → monitor handoff, under one failure transaction from the
 * moment the session record exists.
 * @param {Object} cmd - Parsed command
 * @returns {Promise<Object|undefined>} Session record when detached
 */
async function start_session( cmd ) {

    const launch = await resolve_launch( cmd )
    const { transaction, stored_resume_session } = launch

    let session_data
    try {
        // A resume first finalizes the container its previous launch left
        if( stored_resume_session && !cmd.container_reconciled ) {
            transaction.context = `previous container recovery`
            await recover_clone_container( stored_resume_session )
        }

        launch.startup_status = start_startup_status( `Starting ${ launch.agent.name }` )
        transaction.startup_status = launch.startup_status
        await acquire_credentials( launch )
        await prepare_container( launch )
        await start_tmux_and_prompt( launch )
        session_data = await handoff_to_monitor( launch )
    } catch ( error ) {
        await transaction.fail( error )
        throw error
    }

    log.info( `Session started: ${ launch.agent.name } (${ launch.babysit_id })` )

    cmd.on_handoff?.()
    if( cmd.detached ) return session_data

    await attach_foreground( launch, session_data )

}

/**
 * Append-only log for one session's detached monitor.
 * @param {string} babysit_id - The session id
 * @param {Object} [options]
 * @param {string} [options.babysit_dir] - Base Babysit state directory
 * @returns {string} Absolute log path
 */
export const monitor_log_path = ( babysit_id, { babysit_dir = BABYSIT_DIR } = {} ) => {

    const dir = join( babysit_dir, `monitor-logs` )
    mkdirSync( dir, { recursive: true, mode: 0o700 } )

    return join( dir, `${ babysit_id.replace( /[^a-zA-Z0-9_.-]/g, `_` ) }.log` )

}

/**
 * Spawn `babysit __monitor <id>` as a detached background process.
 * Works for both `node src/index.js` and bun-compiled binaries by detecting
 * which one is running and re-spawning accordingly.
 * @param {string} babysit_id - The session id to monitor
 * @param {string|null} monitor_token - Per-launch monitor identity token
 */
export function spawn_monitor_daemon( babysit_id, monitor_token = null ) {

    return new Promise( ( resolve_spawn, reject_spawn ) => {

        // Bun-compiled binaries set process.argv[1] to a synthetic /$bunfs path;
        // a real node script puts the .js file there. process.execPath points at
        // the binary or `node` respectively in both cases — re-spawning it with
        // the right args runs the same babysit code path.
        const argv1 = process.argv[1] || ``
        const is_compiled = argv1.startsWith( `/$bunfs` ) || argv1 === ``

        const cmd = process.execPath
        const args = is_compiled
            ? [ `__monitor`, babysit_id, monitor_token ].filter( Boolean )
            : [ argv1, `__monitor`, babysit_id, monitor_token ].filter( Boolean )

        // Warnings and errors land in a per-session log instead of /dev/null
        const log_fd = openSync( monitor_log_path( babysit_id ), `a`, 0o600 )
        const child = spawn( cmd, args, {
            detached: true,
            stdio: [ `ignore`, log_fd, log_fd ],
            env: { ...process.env },
        } )
        closeSync( log_fd )

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

}
