import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline/promises'

import { strip_ansi } from '../babysit/matcher.js'
import { read_babysit_config } from '../babysit/config.js'
import {
    BABYSIT_HOST_RC_ENV,
    DEFAULT_BABYSIT_RC_PATH,
    build_docker_command_args,
} from '../docker/run.js'
import { prepare_docker_launch } from '../docker/launch.js'
import { log } from '../utils/log.js'
import { get_agent, SUPPORTED_AGENTS } from './index.js'

export const HOST_AUTH_CHECK_TIMEOUT_MS = 180_000
export const HOST_AUTH_CHECK_KILL_GRACE_MS = 1_500

const cancellation_status = signal => signal?.reason?.code === `skip` ? `skipped` : `cancelled`
const authentication_abort_status = signal => signal?.reason?.code === `timeout`
    ? `failed`
    : cancellation_status( signal )
const authentication_abort_reason = signal => {
    if( signal?.reason?.code === `timeout` ) return `timed out`
    if( signal?.reason?.code === `skip` ) return `skipped by user`
    return `cancelled`
}

const isolated_gemini_auth_settings = raw => {

    let parsed = {}
    try {
        parsed = JSON.parse( raw )
    } catch { /* malformed settings become an empty generated profile */ }

    const selected_type = parsed.security?.auth?.selectedType
    const legacy_selected_type = parsed.auth?.selectedType

    return JSON.stringify( {
        ... typeof selected_type === `string` && selected_type
            ? { security: { auth: { selectedType: selected_type } } }
            : {},
        ... typeof legacy_selected_type === `string` && legacy_selected_type
            ? { auth: { selectedType: legacy_selected_type } }
            : {},
    } )

}

const auth_result = ( name, status, options = {} ) => ( {
    name,
    status,
    authenticated: status === `authenticated`,
    ...options,
} )

const AUTHENTICATION_FAILURE_PATTERNS = [
    /\b(?:401|unauthenticated|unauthorized)\b/i,
    /\b(?:not logged in|login required|please log in|sign in required)\b/i,
    /\bauthentication\s+(?:failed|required)\b/i,
    /\b(?:connect a provider|select auth method|manually enter api key|choose an auth method)\b/i,
    /(?<![A-Za-z0-9])invalid[_\s]+(?:api[_\s]+key|access[_\s]+token|refresh[_\s]+token|credentials?)\b/i,
    /(?<![A-Za-z0-9])(?:api[_\s]+key|access[_\s]+token|refresh[_\s]+token|credentials?)\b[^\n]*(?:missing|expired|invalid|required|not found|not configured)/i,
]

const is_authentication_failure = output =>
    AUTHENTICATION_FAILURE_PATTERNS.some( pattern => pattern.test( output ) )

/**
 * Format a date like the shell example in the boot auth-check prompt.
 * @param {Date} date - Date to format
 * @returns {string} UTC timestamp
 */
export const format_utc_timestamp = ( date = new Date() ) => 
    date.toISOString().replace( `T`, ` ` ).replace( /\.\d{3}Z$/, ` UTC` )


/**
 * Build the prompt each host agent receives for auth validation.
 * @param {Date} date - Date used in the prompt
 * @returns {string} Minimal prompt for a real model call
 */
export const build_host_auth_prompt = ( date = new Date() ) => 
    `The current time is ${ format_utc_timestamp( date ) }. What do you think about that? Respond with just ok`


/**
 * Build the boot message shown before host auth checks start.
 * @param {string[]} agent_names - Host agent names being checked
 * @returns {string} Human-readable auth status message
 */
export const format_host_auth_status_message = ( agent_names = SUPPORTED_AGENTS ) => 
    agent_names.length
        ? `Checking agent auth status...`
        : `No agents configured for authentication checks; skipping authentication checks`

/**
 * Resolve shared host files that can change authentication inside a probe.
 * A nested-Docker carried path is returned even when it is not locally
 * readable; fingerprinting then disables caching rather than omitting it.
 *
 * @param {Object} [mode] - Launch mode
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment lookup
 * @param {Object} [options.agent] - Agent whose provider/account config is used
 * @param {string} [options.babysit_rc_path] - Default host rc path
 * @param {string} [options.home_dir=homedir()] - Host home path
 * @param {Function} [options.path_exists=existsSync] - Filesystem seam
 * @returns {Object<string,string|Object>} Safe context labels to source descriptors
 */
export const resolve_host_auth_context_files = ( mode = {}, {
    env = process.env,
    agent = null,
    babysit_rc_path = DEFAULT_BABYSIT_RC_PATH,
    home_dir = homedir(),
    path_exists = existsSync,
} = {} ) => {

    const context_files = {}
    const carried_path = env[ BABYSIT_HOST_RC_ENV ]
    const source = carried_path || babysit_rc_path
    if( !mode.ignore_host_agents_md && source && ( carried_path || path_exists( source ) ) ) {
        // Nested Babysit carries the outer-daemon source path, which this
        // process cannot read, while the same file is already mounted at the
        // local default path. Hash that readable mirror for warm-cache reuse.
        context_files.babysitrc = carried_path && path_exists( babysit_rc_path )
            ? babysit_rc_path
            : source
    }

    const codex_home = String( env.CODEX_HOME || join( home_dir, `.codex` ) )
        .replace( /^~(?=\/|$)/, home_dir )
        .replace( /\/$/, `` )
    const agent_context_candidates = {
        claude: {
            claude_settings: join( home_dir, `.claude`, `settings.json` ),
            claude_account: join( home_dir, `.claude.json` ),
        },
        codex: {
            codex_config: join( codex_home, `config.toml` ),
        },
        gemini: {
            gemini_settings: join( home_dir, `.gemini`, `settings.json` ),
            gemini_account: join( home_dir, `.gemini`, `google_accounts.json` ),
        },
    }

    const agent_context = mode.ignore_host_agents_md && agent?.name !== `gemini`
        ? {}
        : agent_context_candidates[ agent?.name ] || {}

    Object.entries( agent_context )
        .filter( ( [ , path ] ) => path_exists( path ) )
        .forEach( ( [ key, path ] ) => {
            context_files[ key ] = path
        } )

    if( mode.ignore_host_agents_md && context_files.gemini_settings ) {
        context_files.gemini_settings = {
            path: context_files.gemini_settings,
            transform: isolated_gemini_auth_settings,
        }
    }

    return context_files

}

/**
 * Select host agents configured to receive prompt-level auth checks.
 * @param {Object} [options]
 * @param {string[]|null} [options.agent_names] - Explicit configured agent names
 * @param {Function} [options.read_config] - Host config reader
 * @param {string} [options.config_path] - Host config path
 * @returns {Object[]} Agent adapters to check
 */
export const select_host_auth_check_agents = ( {
    agent_names = null,
    read_config = read_babysit_config,
    config_path = undefined,
} = {} ) => {

    const configured_agent_names = agent_names || read_config( { config_path } ).auth_check_agents

    return configured_agent_names
        .map( get_agent )
        .filter( Boolean )

}


/**
 * Build the command arguments for an agent's host auth check.
 * @param {Object} agent - Agent adapter
 * @param {string} prompt - Prompt to send to the host agent CLI
 * @param {Object} [options]
 * @param {string[]} [options.agent_args=[]] - Effective agent CLI arguments
 * @returns {string[]|null} CLI args, or null when the adapter cannot be checked
 */
export const build_host_auth_args = ( agent, prompt, { agent_args = [], ...options } = {} ) => {

    if( typeof agent?.auth_check?.args !== `function` ) return null
    return agent.auth_check.args( prompt, { agent_args, ...options } )

}

/**
 * Resolve safe, non-secret values that affect an adapter's auth route.
 * @param {Object} agent - Agent adapter
 * @param {string[]} agent_args - Effective CLI passthrough arguments
 * @param {Object} [options] - Workspace/profile context
 * @returns {Object<string,string>} Cache context values
 */
export const resolve_host_auth_context_values = ( agent, agent_args = [], options = {} ) =>
    typeof agent?.auth_check?.cache_context === `function`
        ? agent.auth_check.cache_context( agent_args, options )
        : {}

/**
 * Get the last non-empty line of command output.
 * @param {string} output - Raw or stripped command output
 * @returns {string} Last non-empty output line
 */
export const last_nonempty_line = ( output = `` ) => 
    output.split( /\r?\n/ ).map( line => line.trim() ).filter( Boolean ).at( -1 ) || ``


/**
 * Check whether a host auth probe produced the requested answer.
 * @param {string} output - Stripped command stdout
 * @returns {boolean} True when the final response line is exactly ok
 */
export const answered_ok = ( output = `` ) => /^ok$/i.test( last_nonempty_line( output ) )

/**
 * Build a Dockerized auth-check command for one agent.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.prompt] - Prompt to send
 * @param {string} [options.workspace=process.cwd()] - Workspace used to scope Docker state
 * @param {Object} [options.mode={}] - Babysit mode flags
 * @param {Object[]} [options.creds_mounts=[]] - Credential mounts/env from setup_credentials
 * @param {Object} [options.config={ isolate_dependencies: false }] - Babysit config
 * @param {Object} [options.extra_env={}] - Extra environment variables
 * @param {string[]} [options.agent_args=[]] - Effective agent CLI arguments
 * @returns {Object|null} Docker launch options, or null when the adapter cannot be checked
 */
const build_docker_auth_check_options = ( agent, {
    prompt = build_host_auth_prompt(),
    workspace = process.cwd(),
    mode = {},
    creds_mounts = [],
    config = { isolate_dependencies: false },
    extra_env = {},
    agent_args = [],
    chrome_seccomp_profile_path = null,
} = {} ) => {

    const auth_args = build_host_auth_args( agent, prompt, {
        agent_args,
        workspace,
        include_host_preferences: !mode.ignore_host_agents_md,
    } )
    if( !agent?.bin || !auth_args ) return null

    const agent_extra_env = typeof agent.extra_env === `function`
        ? agent.extra_env( mode )
        : {}
    const auth_mode = {
        ...mode,
        docker: false,
    }

    return {
        agent,
        workspace,
        mode: auth_mode,
        agent_args: [],
        creds_mounts,
        config: {
            ...config,
            isolate_dependencies: false,
        },
        extra_env: {
            ...agent_extra_env,
            ...extra_env,
            NO_COLOR: `1`,
        },
        modifiers: [],
        interactive: false,
        mount_workspace: false,
        include_agents_dir: false,
        include_user_globals: false,
        include_host_agent_context: !mode.ignore_host_agents_md,
        include_loop_deadline: false,
        include_agent_state: false,
        auth_probe: true,
        chrome_seccomp_profile_path,
        agent_command: [
            ...agent.auth_check?.command_prefix || [],
            agent.bin,
            ...auth_args,
        ],
    }

}

/**
 * Build a direct Docker auth-check argv. The real runner routes the same
 * options through prepare_docker_launch so staged credentials are available.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options] - Auth-check launch options
 * @returns {string[]|null} Docker argv, or null when no check is declared
 */
export const build_docker_auth_check_command_args = ( agent, options = {} ) => {

    const docker_options = build_docker_auth_check_options( agent, options )
    return docker_options ? build_docker_command_args( docker_options ) : null

}

/**
 * Run a real prompt through the agent CLI installed inside Babysit's Docker image.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.prompt] - Prompt to send
 * @param {string} [options.workspace=process.cwd()] - Workspace used to scope Docker state
 * @param {Object} [options.mode={}] - Babysit mode flags
 * @param {Object[]} [options.creds_mounts=[]] - Credential mounts/env from setup_credentials
 * @param {Object} [options.config={ isolate_dependencies: false }] - Babysit config
 * @param {Object} [options.extra_env={}] - Extra environment variables
 * @param {string[]} [options.agent_args=[]] - Effective agent CLI arguments
 * @param {Function} [options.spawn_fn=spawn] - Spawn helper for tests
 * @param {Function} [options.prepare_launch=prepare_docker_launch] - Staged launch builder
 * @param {number} [options.timeout_ms=180000] - Max wait before treating the agent as unauthenticated
 * @param {number} [options.kill_grace_ms=1500] - Delay between SIGTERM and SIGKILL on timeout
 * @param {AbortSignal|null} [options.signal] - External cancellation signal
 * @param {Function} [options.on_phase] - Per-agent progress callback
 * @returns {Promise<{ name: string, status: string, authenticated: boolean, reason?: string }>}
 */
export const run_host_agent_auth_check = async ( agent, {
    prompt = build_host_auth_prompt(),
    workspace = process.cwd(),
    mode = {},
    creds_mounts = [],
    config = { isolate_dependencies: false },
    extra_env = {},
    agent_args = [],
    spawn_fn = spawn,
    timeout_ms = HOST_AUTH_CHECK_TIMEOUT_MS,
    kill_grace_ms = HOST_AUTH_CHECK_KILL_GRACE_MS,
    prepare_launch = prepare_docker_launch,
    signal = null,
    on_phase = () => {},
} = {} ) => {

    // One deadline covers Docker preparation as well as the agent process.
    // Credential recovery remains awaited after cancellation so a refreshed
    // one-use token is never destroyed just to meet a wall-clock target.
    const lifecycle_controller = new AbortController()
    const forward_abort = () => lifecycle_controller.abort( signal?.reason )
    const lifecycle_timeout = setTimeout(
        () => lifecycle_controller.abort( { code: `timeout` } ),
        timeout_ms
    )
    lifecycle_timeout.unref?.()
    signal?.addEventListener?.( `abort`, forward_abort, { once: true } )
    if( signal?.aborted ) forward_abort()
    const auth_signal = lifecycle_controller.signal
    const clear_lifecycle = () => {
        clearTimeout( lifecycle_timeout )
        signal?.removeEventListener?.( `abort`, forward_abort )
    }

    let current_phase = null
    let phase_started_at = Date.now()
    const set_phase = ( name, phase ) => {
        if( process.env.BABYSIT_DEBUG === `1` && current_phase ) {
            log.info( `Timing auth ${ name } ${ current_phase }: ${ Date.now() - phase_started_at }ms` )
        }
        current_phase = phase
        phase_started_at = Date.now()
        on_phase( name, phase )
    }

    const docker_options = build_docker_auth_check_options( agent, {
        prompt,
        workspace,
        mode,
        creds_mounts,
        config,
        extra_env,
        agent_args,
    } )
    if( !docker_options ) {
        clear_lifecycle()
        return auth_result( agent?.name || `unknown`, `failed`, {
            reason: `missing auth check command`,
        } )
    }

    let prepared_launch
    try {
        set_phase( agent.name, `preparing` )
        prepared_launch = await prepare_launch( docker_options, { signal: auth_signal } )
    } catch ( error ) {
        const status = auth_signal.aborted ? authentication_abort_status( auth_signal ) : `failed`
        clear_lifecycle()
        return auth_result( agent?.name || `unknown`, status, {
            reason: auth_signal.reason?.code === `timeout`
                ? authentication_abort_reason( auth_signal )
                : error.message,
        } )
    }

    if( auth_signal.aborted ) {
        try {
            await prepared_launch.abort()
        } finally {
            clear_lifecycle()
        }
        return auth_result( agent.name, authentication_abort_status( auth_signal ), {
            reason: authentication_abort_reason( auth_signal ),
        } )
    }

    const { command_args } = prepared_launch

    return new Promise( resolve => {

        const [ cmd, ...args ] = command_args
        const child = spawn_fn( cmd, args, {
            stdio: [ `ignore`, `pipe`, `pipe` ],
            env: {
                ...process.env,
                NO_COLOR: `1`,
            },
        } )

        let stdout = ``
        let stderr = ``
        let settled = false
        let kill_timeout
        let termination_status = null
        let termination_reason = null
        let finalise_task = null

        const current_output = () => strip_ansi( stdout ).trim()
        const clear_kill_timeout = () => clearTimeout( kill_timeout )

        const finalise_launch = () => {
            if( finalise_task ) return finalise_task

            finalise_task = ( async () => {
                let flush_error = null

                set_phase( agent.name, `recovering credentials` )
                try {
                    await prepared_launch.pull_synced_files?.( {
                        target: agent.container_paths?.creds || null,
                    } )
                } catch ( error ) {
                    flush_error = error
                }

                if( flush_error ) {
                    const retained_container = prepared_launch.retain
                        ? await prepared_launch.retain( { stop: Boolean( termination_status ) } )
                        : null
                    if( !prepared_launch.retain ) prepared_launch.handoff?.()

                    log.warn(
                        `Could not recover refreshed ${ agent.name } credentials from auth probe; retaining ${ retained_container || prepared_launch.container_id || `the probe container` } for manual recovery: ${ flush_error.message }`
                    )
                    return flush_error
                }

                await prepared_launch.abort()
                return flush_error
            } )()

            return finalise_task
        }

        let on_abort = () => {}

        const finish = result => {
            if( settled ) return

            settled = true
            clear_kill_timeout()
            auth_signal.removeEventListener?.( `abort`, on_abort )
            clear_lifecycle()
            set_phase( agent.name, result.status )
            resolve( result )
        }

        const begin_termination = ( status, reason ) => {
            if( settled || termination_status ) return

            termination_status = status
            termination_reason = reason
            set_phase( agent.name, `recovering credentials` )
            child.kill?.( `SIGTERM` )
            kill_timeout = setTimeout( async () => {
                child.kill?.( `SIGKILL` )
                const flush_error = await finalise_launch()
                finish( auth_result( agent.name, status, {
                    reason: flush_error?.message || reason,
                    output: current_output(),
                } ) )
            }, kill_grace_ms )
        }

        on_abort = () => begin_termination(
            authentication_abort_status( auth_signal ),
            authentication_abort_reason( auth_signal )
        )

        child.stdout?.on( `data`, chunk => {
            stdout += chunk.toString()
        } )

        child.stderr?.on( `data`, chunk => {
            stderr += chunk.toString()
        } )

        child.on( `error`, async error => {
            clear_kill_timeout()
            const flush_error = await finalise_launch()
            const status = termination_status || `failed`
            finish( auth_result( agent.name, status, {
                reason: flush_error?.message || termination_reason || error.message,
                output: current_output(),
            } ) )
        } )

        child.on( `close`, async code => {
            clear_kill_timeout()
            const flush_error = await finalise_launch()

            const output = current_output()
            const diagnostic = strip_ansi( stderr || stdout ).trim()
            const authentication_diagnostic = strip_ansi( `${ stderr }\n${ stdout }` ).trim()
            if( termination_status ) {
                finish( auth_result( agent.name, termination_status, {
                    reason: flush_error?.message || termination_reason,
                    output,
                } ) )
                return
            }

            const is_authenticated = !flush_error && code === 0 && answered_ok( output )
            const status = is_authenticated
                ? `authenticated`
                : is_authentication_failure( authentication_diagnostic ) ? `unauthenticated` : `failed`
            const failure_reason = flush_error?.message || diagnostic || `exited with code ${ code }`

            finish( auth_result( agent.name, status, {
                reason: is_authenticated ? undefined : failure_reason,
                output,
            } ) )
        } )

        set_phase( agent.name, `checking` )
        auth_signal.addEventListener?.( `abort`, on_abort, { once: true } )
        if( auth_signal.aborted ) on_abort()

    } )

}

/**
 * Check prompt-level host authentication for configured supported agents.
 * @param {Object} [options]
 * @param {string[]|null} [options.agent_names] - Agent names to check
 * @param {Object[]|null} [options.agents] - Pre-selected agent adapters to check
 * @param {Date} [options.date=new Date()] - Date used in the shared prompt
 * @param {Function} [options.run_auth_check=run_host_agent_auth_check] - Runner for tests
 * @param {AbortSignal|null} [options.signal] - Shared cancellation signal
 * @param {Function} [options.on_state] - Per-agent progress callback
 * @returns {Promise<Array<{ name: string, status: string, authenticated: boolean, reason?: string }>>}
 */
export const check_host_agent_authentication = async ( {
    agent_names = null,
    agents = null,
    date = new Date(),
    run_auth_check = run_host_agent_auth_check,
    signal = null,
    on_state = () => {},
} = {} ) => {

    const prompt = build_host_auth_prompt( date )
    const agents_to_check = agents || select_host_auth_check_agents( { agent_names } )

    const auth_tasks = agents_to_check.map( agent =>
        Promise.resolve().then( () => run_auth_check( agent, {
            prompt,
            signal,
            on_phase: on_state,
        } ) )
    )
    const results = await Promise.allSettled( auth_tasks )

    const auth_results = results.map( ( result, index ) => {
        if( result.status === `fulfilled` ) return result.value

        const status = signal?.aborted ? cancellation_status( signal ) : `failed`
        return auth_result( agents_to_check[index].name, status, {
            reason: result.reason?.message || String( result.reason ),
        } )
    } )

    return auth_results

}

/**
 * Extract explicitly unauthenticated agent names from auth-check results.
 * @param {Array<{ name: string, authenticated: boolean }>} results - Auth-check results
 * @returns {string[]} Unauthenticated agent names
 */
export const unauthenticated_agent_names = ( results = [] ) => 
    results
        .filter( result => result.status
            ? result.status === `unauthenticated`
            : !result.authenticated
        )
        .map( result => result.name )

/**
 * Extract agents whose model-backed check failed for a non-auth reason.
 * @param {Array<{ name: string, status?: string }>} results - Auth-check results
 * @returns {string[]} Failed agent names
 */
export const failed_agent_names = ( results = [] ) =>
    results.filter( result => result.status === `failed` ).map( result => result.name )


/**
 * Interpret the answer to "Exit? [Y/n]".
 * @param {string} answer - Raw answer
 * @returns {boolean} True when Babysit should continue despite failed auth checks
 */
export const should_continue_with_unauthenticated_agents = ( answer = `` ) => /^n(o)?$/i.test( answer.trim() )

/**
 * Prompt before starting a main session with unauthenticated host agents.
 * @param {string[]} names - Unauthenticated agent names
 * @param {Object} [io]
 * @param {string[]} [io.failed_names=[]] - Agents with non-auth probe failures
 * @param {NodeJS.ReadableStream} [io.input=process.stdin] - Prompt input
 * @param {NodeJS.WritableStream} [io.output=process.stdout] - Prompt output
 * @returns {Promise<boolean>} True when the user chose to continue
 */
export const confirm_continue_with_unauthenticated_agents = async ( names, {
    input = process.stdin,
    output = process.stdout,
    failed_names = [],
} = {} ) => {

    const question = [
        names.length ? `Unauthenticated agents: ${ names.join( `, ` ) }.` : null,
        failed_names.length ? `Authentication checks failed: ${ failed_names.join( `, ` ) }.` : null,
        `Run \`babysit doctor --auth\` to check authentication explicitly.`,
        `Exit? [Y/n] `,
    ].filter( Boolean ).join( `\n` )

    if( !input.isTTY ) {
        output.write( `${ question }\n` )
        return false
    }

    const rl = createInterface( { input, output } )

    try {
        const answer = await rl.question( question )
        return should_continue_with_unauthenticated_agents( answer )
    } finally {
        rl.close()
    }

}
