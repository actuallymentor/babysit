import { spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createInterface } from 'readline/promises'

import { strip_ansi } from '../babysit/matcher.js'
import { resolve_credential_file } from '../credentials/paths.js'
import { build_docker_command_args } from '../docker/run.js'
import { detect_platform } from '../utils/platform.js'
import { BABYSIT_DIR } from '../utils/paths.js'
import { get_agent, SUPPORTED_AGENTS } from './index.js'

export const HOST_AUTH_CHECK_TIMEOUT_MS = 90_000
export const HOST_AUTH_CHECK_KILL_GRACE_MS = 1_500
export const HOST_AUTH_RECENCY_DAYS = 7
export const HOST_AUTH_RECENCY_MS = HOST_AUTH_RECENCY_DAYS * 24 * 60 * 60 * 1_000
export const HOST_AUTH_CACHE_PATH = join( BABYSIT_DIR, `host-auth-cache.json` )

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
        : `No recent host agent authentications found; skipping authentication checks`

/**
 * Read the lightweight host auth cache. It stores timestamps only, never
 * credential content.
 * @param {Object} [options]
 * @param {string} [options.cache_path] - Cache file path
 * @returns {{ version: number, agents: Object }} Cache contents
 */
export const read_host_auth_cache = ( {
    cache_path = HOST_AUTH_CACHE_PATH,
} = {} ) => {

    try {
        if( !existsSync( cache_path ) ) return { version: 1, agents: {} }

        const parsed = JSON.parse( readFileSync( cache_path, `utf-8` ) )
        return {
            version: 1,
            agents: parsed?.agents && typeof parsed.agents === `object` ? parsed.agents : {},
        }
    } catch {
        return { version: 1, agents: {} }
    }

}

/**
 * Persist successful host auth checks for future boot filtering.
 * @param {string[]} agent_names - Agent names that successfully answered the prompt check
 * @param {Object} [options]
 * @param {Date} [options.date] - Timestamp to store
 * @param {string} [options.cache_path] - Cache file path
 * @returns {{ version: number, agents: Object }} Updated cache
 */
export const record_host_auth_successes = ( agent_names = [], {
    date = new Date(),
    cache_path = HOST_AUTH_CACHE_PATH,
} = {} ) => {

    const cache = read_host_auth_cache( { cache_path } )
    const authenticated_at = date.toISOString()
    const cache_entry = name => cache.agents?.[ name ] || {}
    const agents = {
        ...cache.agents,
        ...Object.fromEntries(
            agent_names.map( name => [
                name,
                {
                    ...cache_entry( name ),
                    authenticated_at,
                },
            ] )
        ),
    }
    const next_cache = { version: 1, agents }

    try {
        mkdirSync( dirname( cache_path ), { recursive: true } )
        writeFileSync( cache_path, `${ JSON.stringify( next_cache, null, 2 ) }\n` )
    } catch {
        // Cache writes should never block the actual auth check flow.
    }

    return next_cache

}

/**
 * Check whether a timestamp is inside the host auth relevance window.
 * @param {string|number|Date} value - Timestamp value
 * @param {Object} [options]
 * @param {Date} [options.date] - Reference time
 * @param {number} [options.recency_ms] - Allowed age
 * @returns {boolean} True when the timestamp is recent enough
 */
export const is_recent_host_auth_timestamp = ( value, {
    date = new Date(),
    recency_ms = HOST_AUTH_RECENCY_MS,
} = {} ) => {

    const timestamp = value instanceof Date ? value.getTime() : new Date( value ).getTime()
    if( !Number.isFinite( timestamp ) ) return false

    const age_ms = date.getTime() - timestamp
    return age_ms >= 0 && age_ms <= recency_ms

}

/**
 * Resolve the credential metadata for the current host platform.
 * @param {Object} agent - Agent adapter
 * @param {string} [platform] - Host platform
 * @returns {Object|null} Credential config
 */
export const get_host_credential_config = ( agent, platform = detect_platform() ) =>
    agent?.credentials?.[ platform ] || null

/**
 * Check for credential environment variables that imply intentional current use.
 * @param {Object|null} cred_config - Agent credential metadata
 * @param {Object} [env] - Environment values
 * @returns {boolean} True when a supported auth env var is present
 */
export const has_host_auth_env = ( cred_config, env = process.env ) => {

    const primary = cred_config?.env_key && env[ cred_config.env_key ]
    const fallback = cred_config?.fallback_env && env[ cred_config.fallback_env ]

    return Boolean( primary || fallback )

}

/**
 * Check whether an agent has a recent host credential file.
 * This intentionally uses stat metadata only and never reads credential content.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {Date} [options.date] - Reference time
 * @param {string} [options.platform] - Host platform
 * @param {number} [options.recency_ms] - Allowed age
 * @returns {{ recent: boolean, path?: string, mtime?: Date }} Credential file evidence
 */
export const get_recent_host_credential_file_evidence = ( agent, {
    date = new Date(),
    platform = detect_platform(),
    recency_ms = HOST_AUTH_RECENCY_MS,
} = {} ) => {

    const cred_config = get_host_credential_config( agent, platform )
    const file = cred_config?.file || cred_config?.fallback_file
    if( !file ) return { recent: false }

    const path = resolve_credential_file( file )

    try {
        const stat = statSync( path )
        if( !stat.isFile() ) return { recent: false, path, mtime: stat.mtime }

        return {
            recent: is_recent_host_auth_timestamp( stat.mtime, { date, recency_ms } ),
            path,
            mtime: stat.mtime,
        }
    } catch {
        return { recent: false, path }
    }

}

/**
 * Decide whether a host agent is worth a real prompt-level auth check.
 * The active agent is always checked. Inactive agents need recent evidence so
 * legacy installs do not slow down startup or trigger irrelevant auth prompts.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string|null} [options.active_agent_name] - Agent requested for this session
 * @param {Object} [options.cache] - Parsed host auth cache
 * @param {Date} [options.date] - Reference time
 * @param {Object} [options.env] - Environment values
 * @param {string} [options.platform] - Host platform
 * @param {number} [options.recency_ms] - Allowed age
 * @returns {{ should_check: boolean, reason: string }} Auth-check decision
 */
export const get_host_auth_check_decision = ( agent, {
    active_agent_name = null,
    cache = { agents: {} },
    date = new Date(),
    env = process.env,
    platform = detect_platform(),
    recency_ms = HOST_AUTH_RECENCY_MS,
} = {} ) => {

    if( agent?.name && agent.name === active_agent_name ) {
        return { should_check: true, reason: `active agent` }
    }

    const authenticated_at = cache?.agents?.[ agent?.name ]?.authenticated_at
    if( is_recent_host_auth_timestamp( authenticated_at, { date, recency_ms } ) ) {
        return { should_check: true, reason: `recent successful auth check` }
    }

    const cred_config = get_host_credential_config( agent, platform )
    if( has_host_auth_env( cred_config, env ) ) {
        return { should_check: true, reason: `auth environment variable present` }
    }

    const file_evidence = get_recent_host_credential_file_evidence( agent, {
        date,
        platform,
        recency_ms,
    } )
    if( file_evidence.recent ) return { should_check: true, reason: `recent credential file` }

    return { should_check: false, reason: `no recent auth evidence` }

}

/**
 * Select host agents that should receive prompt-level auth checks.
 * @param {Object} [options]
 * @param {string[]} [options.agent_names=SUPPORTED_AGENTS] - Candidate agent names
 * @param {string|null} [options.active_agent_name] - Agent requested for this session
 * @param {Date} [options.date] - Reference time
 * @param {Function} [options.read_cache] - Cache reader
 * @param {string} [options.cache_path] - Cache file path
 * @param {Object} [options.env] - Environment values
 * @param {string} [options.platform] - Host platform
 * @param {number} [options.recency_ms] - Allowed age
 * @returns {Object[]} Agent adapters to check
 */
export const select_host_auth_check_agents = ( {
    agent_names = SUPPORTED_AGENTS,
    active_agent_name = null,
    date = new Date(),
    read_cache = read_host_auth_cache,
    cache_path = HOST_AUTH_CACHE_PATH,
    env = process.env,
    platform = detect_platform(),
    recency_ms = HOST_AUTH_RECENCY_MS,
} = {} ) => {

    const cache = read_cache( { cache_path } )

    return agent_names
        .map( get_agent )
        .filter( Boolean )
        .filter( agent => get_host_auth_check_decision( agent, {
            active_agent_name,
            cache,
            date,
            env,
            platform,
            recency_ms,
        } ).should_check )

}


/**
 * Build the command arguments for an agent's host auth check.
 * @param {Object} agent - Agent adapter
 * @param {string} prompt - Prompt to send to the host agent CLI
 * @returns {string[]|null} CLI args, or null when the adapter cannot be checked
 */
export const build_host_auth_args = ( agent, prompt ) => {

    if( typeof agent?.auth_check?.args !== `function` ) return null
    return agent.auth_check.args( prompt )

}

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
 * @returns {string[]|null} Docker argv, or null when the adapter cannot be checked
 */
export const build_docker_auth_check_command_args = ( agent, {
    prompt = build_host_auth_prompt(),
    workspace = process.cwd(),
    mode = {},
    creds_mounts = [],
    config = { isolate_dependencies: false },
    extra_env = {},
} = {} ) => {

    const auth_args = build_host_auth_args( agent, prompt )
    if( !agent?.bin || !auth_args ) return null

    const agent_extra_env = typeof agent.extra_env === `function`
        ? agent.extra_env( mode )
        : {}
    const auth_mode = {
        ...mode,
        docker: false,
    }

    return build_docker_command_args( {
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
        include_loop_deadline: false,
        include_agent_state: false,
        agent_command: [ agent.bin, ...auth_args ],
    } )

}

/**
 * Extract the generated Docker container name from auth-check argv.
 * @param {string[]} command_args - Docker run command argv
 * @returns {string|null} Container name, or null when absent
 */
export const docker_auth_check_container_name = ( command_args = [] ) => {

    const name_index = command_args.indexOf( `--name` )
    if( name_index === -1 ) return null

    return command_args[ name_index + 1 ] || null

}

/**
 * Build the cleanup command for a timed-out auth-check container.
 * Killing `docker run` with SIGKILL does not propagate SIGKILL into the
 * container, so timeout cleanup must reap the container explicitly.
 * @param {string[]} command_args - Docker run command argv
 * @returns {string[]|null} Docker cleanup argv, or null when no name is present
 */
export const build_docker_auth_check_cleanup_command_args = ( command_args = [] ) => {

    const container_name = docker_auth_check_container_name( command_args )
    if( !container_name ) return null

    const docker_prefix = command_args[0] === `sudo`
        ? [ `sudo`, `docker` ]
        : [ `docker` ]

    return [ ...docker_prefix, `rm`, `-f`, container_name ]

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
 * @param {Function} [options.spawn_fn=spawn] - Spawn helper for tests
 * @param {Function} [options.cleanup_spawn_fn=spawn] - Spawn helper for timeout cleanup
 * @param {number} [options.timeout_ms=90000] - Max wait before treating the agent as unauthenticated
 * @param {number} [options.kill_grace_ms=1500] - Delay between SIGTERM and SIGKILL on timeout
 * @returns {Promise<{ name: string, authenticated: boolean, reason?: string }>}
 */
export const run_host_agent_auth_check = async ( agent, {
    prompt = build_host_auth_prompt(),
    workspace = process.cwd(),
    mode = {},
    creds_mounts = [],
    config = { isolate_dependencies: false },
    extra_env = {},
    spawn_fn = spawn,
    cleanup_spawn_fn = spawn,
    timeout_ms = HOST_AUTH_CHECK_TIMEOUT_MS,
    kill_grace_ms = HOST_AUTH_CHECK_KILL_GRACE_MS,
} = {} ) => new Promise( resolve => {

    const command_args = build_docker_auth_check_command_args( agent, {
        prompt,
        workspace,
        mode,
        creds_mounts,
        config,
        extra_env,
    } )
    if( !command_args ) {
        resolve( {
            name: agent?.name || `unknown`,
            authenticated: false,
            reason: `missing auth check command`,
        } )
        return
    }

    const [ cmd, ...args ] = command_args
    const cleanup_command_args = build_docker_auth_check_cleanup_command_args( command_args )
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
    let timeout
    let kill_timeout

    const current_output = () => strip_ansi( stdout ).trim()
    const clear_kill_timeout = () => clearTimeout( kill_timeout )

    const cleanup_timed_out_container = () => {

        if( !cleanup_command_args ) return

        const [ cleanup_cmd, ...cleanup_args ] = cleanup_command_args
        const cleanup_child = cleanup_spawn_fn( cleanup_cmd, cleanup_args, {
            stdio: `ignore`,
            env: {
                ...process.env,
                NO_COLOR: `1`,
            },
        } )

        cleanup_child?.on?.( `error`, () => {} )
        cleanup_child?.unref?.()

    }

    const finish = ( result, { keep_kill_timeout = false } = {} ) => {
        if( settled ) return

        settled = true
        clearTimeout( timeout )
        if( !keep_kill_timeout ) clear_kill_timeout()
        resolve( result )
    }

    timeout = setTimeout( () => {
        if( typeof child.kill === `function` ) child.kill( `SIGTERM` )
        kill_timeout = setTimeout( () => {
            if( typeof child.kill === `function` ) child.kill( `SIGKILL` )
            cleanup_timed_out_container()
        }, kill_grace_ms )

        finish( {
            name: agent.name,
            authenticated: false,
            reason: `timed out`,
            output: current_output(),
        }, { keep_kill_timeout: true } )
    }, timeout_ms )

    child.stdout?.on( `data`, chunk => {
        stdout += chunk.toString()
    } )

    child.stderr?.on( `data`, chunk => {
        stderr += chunk.toString()
    } )

    child.on( `error`, error => {
        clear_kill_timeout()
        finish( {
            name: agent.name,
            authenticated: false,
            reason: error.message,
            output: current_output(),
        } )
    } )

    child.on( `close`, code => {
        clear_kill_timeout()
        const output = current_output()
        const diagnostic = strip_ansi( stderr || stdout ).trim()
        const is_authenticated = code === 0 && answered_ok( output )

        finish( {
            name: agent.name,
            authenticated: is_authenticated,
            reason: is_authenticated ? undefined : diagnostic || `exited with code ${ code }`,
            output,
        } )
    } )

} )

/**
 * Check prompt-level host authentication for relevant supported agents.
 * @param {Object} [options]
 * @param {string[]} [options.agent_names=SUPPORTED_AGENTS] - Candidate agent names
 * @param {string|null} [options.active_agent_name] - Agent requested for this session
 * @param {Object[]|null} [options.agents] - Pre-selected agent adapters to check
 * @param {Date} [options.date=new Date()] - Date used in the shared prompt
 * @param {Function} [options.run_auth_check=run_host_agent_auth_check] - Runner for tests
 * @param {boolean} [options.filter_by_recent_auth_evidence=true] - Whether to skip inactive agents without recent evidence
 * @param {Function} [options.record_auth_successes=record_host_auth_successes] - Cache writer
 * @param {string} [options.cache_path] - Cache file path
 * @returns {Promise<Array<{ name: string, authenticated: boolean, reason?: string }>>}
 */
export const check_host_agent_authentication = async ( {
    agent_names = SUPPORTED_AGENTS,
    active_agent_name = null,
    agents = null,
    date = new Date(),
    run_auth_check = run_host_agent_auth_check,
    filter_by_recent_auth_evidence = true,
    record_auth_successes = record_host_auth_successes,
    cache_path = HOST_AUTH_CACHE_PATH,
} = {} ) => {

    const prompt = build_host_auth_prompt( date )
    const agents_to_check = agents || (
        filter_by_recent_auth_evidence
            ? select_host_auth_check_agents( {
                agent_names,
                active_agent_name,
                date,
                cache_path,
            } )
            : agent_names.map( get_agent ).filter( Boolean )
    )

    const auth_tasks = agents_to_check.map( agent =>
        Promise.resolve().then( () => run_auth_check( agent, { prompt } ) )
    )
    const results = await Promise.allSettled( auth_tasks )

    const auth_results = results.map( ( result, index ) => {
        if( result.status === `fulfilled` ) return result.value

        return {
            name: agents_to_check[index].name,
            authenticated: false,
            reason: result.reason?.message || String( result.reason ),
        }
    } )

    const authenticated_agent_names = auth_results
        .filter( result => result.authenticated )
        .map( result => result.name )

    if( authenticated_agent_names.length ) {
        record_auth_successes( authenticated_agent_names, { date, cache_path } )
    }

    return auth_results

}

/**
 * Extract failed agent names from auth-check results.
 * @param {Array<{ name: string, authenticated: boolean }>} results - Auth-check results
 * @returns {string[]} Unauthenticated agent names
 */
export const unauthenticated_agent_names = ( results = [] ) => 
    results.filter( result => !result.authenticated ).map( result => result.name )


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
 * @param {NodeJS.ReadableStream} [io.input=process.stdin] - Prompt input
 * @param {NodeJS.WritableStream} [io.output=process.stdout] - Prompt output
 * @returns {Promise<boolean>} True when the user chose to continue
 */
export const confirm_continue_with_unauthenticated_agents = async ( names, {
    input = process.stdin,
    output = process.stdout,
} = {} ) => {

    const question = `Unauthenticated agents: ${ names.join( `, ` ) }. Exit? [Y/n] `
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
