import { spawn } from 'child_process'
import { createInterface } from 'readline/promises'

import { strip_ansi } from '../babysit/matcher.js'
import { get_agent, SUPPORTED_AGENTS } from './index.js'

export const HOST_AUTH_CHECK_TIMEOUT_MS = 90_000

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
 * Run a real prompt through one host-installed agent CLI.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.prompt] - Prompt to send
 * @param {Function} [options.spawn_fn=spawn] - Spawn helper for tests
 * @param {number} [options.timeout_ms=90000] - Max wait before treating the agent as unauthenticated
 * @returns {Promise<{ name: string, authenticated: boolean, reason?: string }>}
 */
export const run_host_agent_auth_check = async ( agent, {
    prompt = build_host_auth_prompt(),
    spawn_fn = spawn,
    timeout_ms = HOST_AUTH_CHECK_TIMEOUT_MS,
} = {} ) => new Promise( resolve => {

    const args = build_host_auth_args( agent, prompt )
    if( !agent?.bin || !args ) {
        resolve( {
            name: agent?.name || `unknown`,
            authenticated: false,
            reason: `missing auth check command`,
        } )
        return
    }

    const child = spawn_fn( agent.bin, args, {
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

    const finish = result => {
        if( settled ) return

        settled = true
        clearTimeout( timeout )
        resolve( result )
    }

    timeout = setTimeout( () => {
        if( typeof child.kill === `function` ) child.kill( `SIGTERM` )
        finish( {
            name: agent.name,
            authenticated: false,
            reason: `timed out`,
        } )
    }, timeout_ms )

    child.stdout?.on( `data`, chunk => {
        stdout += chunk.toString()
    } )

    child.stderr?.on( `data`, chunk => {
        stderr += chunk.toString()
    } )

    child.on( `error`, error => finish( {
        name: agent.name,
        authenticated: false,
        reason: error.message,
    } ) )

    child.on( `close`, code => {
        const output = strip_ansi( stdout ).trim()
        const diagnostic = strip_ansi( stderr || stdout ).trim()
        const answered_ok = /\bok\b/i.test( output )

        finish( {
            name: agent.name,
            authenticated: code === 0 && answered_ok,
            reason: code === 0 && answered_ok ? undefined : diagnostic || `exited with code ${ code }`,
            output,
        } )
    } )

} )

/**
 * Check prompt-level host authentication for every supported agent.
 * @param {Object} [options]
 * @param {string[]} [options.agent_names=SUPPORTED_AGENTS] - Agent names to check
 * @param {Date} [options.date=new Date()] - Date used in the shared prompt
 * @param {Function} [options.run_auth_check=run_host_agent_auth_check] - Runner for tests
 * @returns {Promise<Array<{ name: string, authenticated: boolean, reason?: string }>>}
 */
export const check_host_agent_authentication = async ( {
    agent_names = SUPPORTED_AGENTS,
    date = new Date(),
    run_auth_check = run_host_agent_auth_check,
} = {} ) => {

    const prompt = build_host_auth_prompt( date )
    const agents = agent_names.map( get_agent ).filter( Boolean )

    return Promise.all( agents.map( agent => run_auth_check( agent, { prompt } ) ) )

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
    const rl = createInterface( { input, output } )

    try {
        const answer = await rl.question( question )
        return should_continue_with_unauthenticated_agents( answer )
    } finally {
        rl.close()
    }

}
