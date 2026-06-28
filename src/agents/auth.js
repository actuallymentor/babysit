import { spawn } from 'child_process'
import { createInterface } from 'readline/promises'

import { strip_ansi } from '../babysit/matcher.js'
import { read_babysit_config } from '../babysit/config.js'
import { build_docker_command_args } from '../docker/run.js'
import { get_agent, SUPPORTED_AGENTS } from './index.js'

export const HOST_AUTH_CHECK_TIMEOUT_MS = 90_000
export const HOST_AUTH_CHECK_KILL_GRACE_MS = 1_500

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
 * Check prompt-level host authentication for configured supported agents.
 * @param {Object} [options]
 * @param {string[]|null} [options.agent_names] - Agent names to check
 * @param {Object[]|null} [options.agents] - Pre-selected agent adapters to check
 * @param {Date} [options.date=new Date()] - Date used in the shared prompt
 * @param {Function} [options.run_auth_check=run_host_agent_auth_check] - Runner for tests
 * @returns {Promise<Array<{ name: string, authenticated: boolean, reason?: string }>>}
 */
export const check_host_agent_authentication = async ( {
    agent_names = null,
    agents = null,
    date = new Date(),
    run_auth_check = run_host_agent_auth_check,
} = {} ) => {

    const prompt = build_host_auth_prompt( date )
    const agents_to_check = agents || select_host_auth_check_agents( { agent_names } )

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

    const question = [
        `Unauthenticated agents: ${ names.join( `, ` ) }.`,
        `Run \`babysit config\` to choose which coding agents Babysit checks on startup.`,
        `Exit? [Y/n] `,
    ].join( `\n` )

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
