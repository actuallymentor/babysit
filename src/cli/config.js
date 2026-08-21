import { SUPPORTED_AGENTS } from '../agents/index.js'
import {
    DEFAULT_AUTH_CHECK_AGENTS,
    read_babysit_config,
    normalise_auth_check_agents,
    write_babysit_config,
} from '../babysit/config.js'

/**
 * Render an agent list for human-facing CLI output.
 * @param {string[]} agent_names - Agent names
 * @returns {string} Comma-separated list or "none"
 */
export const format_auth_check_agents = ( agent_names = [] ) =>
    agent_names.length ? agent_names.join( `, ` ) : `none`

/**
 * Parse a user-entered auth-check agent selection.
 * @param {string} input - Raw CLI input
 * @param {Object} [options]
 * @param {string[]} [options.current] - Current selection used when input is blank
 * @param {string[]} [options.supported_agents] - Allowed agent names
 * @returns {string[]} Selected agent names
 */
export const parse_auth_check_agent_selection = ( input, {
    current = DEFAULT_AUTH_CHECK_AGENTS,
    supported_agents = SUPPORTED_AGENTS,
} = {} ) => {

    const raw = String( input ?? `` ).trim()
    if( !raw ) return normalise_auth_check_agents( current, { supported_agents } )
    if( /^all$/i.test( raw ) ) return [ ...supported_agents ]
    if( /^(none|off|disabled?)$/i.test( raw ) ) return []

    const requested_agents = raw
        .split( /[,\s]+/ )
        .map( name => name.trim().toLowerCase() )
        .filter( Boolean )

    const invalid_agents = requested_agents.filter( name => !supported_agents.includes( name ) )
    if( invalid_agents.length ) {
        throw new Error(
            `Unsupported agent(s): ${ invalid_agents.join( `, ` ) }. Supported agents: ${ supported_agents.join( `, ` ) }`
        )
    }

    return normalise_auth_check_agents( requested_agents, { supported_agents } )

}

/**
 * `babysit config` — edit host-level Babysit settings.
 * @param {Object} cmd - Parsed command
 * @param {Object} [io]
 * @param {NodeJS.ReadableStream} [io.input] - Prompt input
 * @param {NodeJS.WritableStream} [io.output] - Prompt output
 * @param {string} [io.config_path] - Config file path
 */
export const cmd_config = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    config_path = undefined,
} = {} ) => {

    const current_config = read_babysit_config( { config_path } )
    const direct_selection = cmd.flags.auth_check_agents

    if( typeof direct_selection === `string` ) {
        const auth_check_agents = parse_auth_check_agent_selection( direct_selection, {
            current: current_config.auth_check_agents,
        } )
        const next_config = write_babysit_config( { auth_check_agents }, { config_path } )

        output.write(
            `Legacy authentication selection saved: ${ format_auth_check_agents( next_config.auth_check_agents ) } (deprecated; startup and doctor ignore it)\n`
        )
        return
    }

    output.write( `\nbabysit config\n\n` )
    output.write( `Startup authentication: all supported agents, with concurrent misses and a 12-hour auth-input-bound success cache\n` )
    output.write( `Explicit checks: babysit doctor --auth [agent|all]\n` )
    output.write(
        `Legacy authentication selection: ${ format_auth_check_agents( current_config.auth_check_agents ) } (deprecated and ignored)\n`
    )

}
