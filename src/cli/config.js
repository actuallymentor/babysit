import { SUPPORTED_AGENTS } from '../agents/index.js'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BABYSIT_DIR, SESSIONS_DIR, CLONES_DIR, AGENTS_DIR, TMUX_SOCKET } from '../utils/paths.js'
import { get_image_name } from '../docker/update.js'
import { read_launch_defaults } from '../babysit/launch_defaults.js'
import { web_bridge_paths } from '../web_bridge/paths.js'
import { read_recovery_status } from './config_status.js'
import {
    BABYSIT_CONFIG_PATH,
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
 * `babysit config` — inspect effective settings without creating configuration.
 * @param {Object} cmd - Parsed command
 * @param {Object} [io]
 * @param {NodeJS.ReadableStream} [io.input] - Prompt input
 * @param {NodeJS.WritableStream} [io.output] - Prompt output
 * @param {string} [io.config_path] - Config file path
 */
export const cmd_config = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    config_path = BABYSIT_CONFIG_PATH,
    recovery_status = read_recovery_status,
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

    const recovery = await recovery_status()
    const defaults = read_launch_defaults()
    const web = web_bridge_paths()
    const file_status = path => `${ path } (${ existsSync( path ) ? `present` : `not present` })`
    const toggle = enabled => enabled ? `on` : `off`
    const rows = [
        [ `Home directory`, `${ BABYSIT_DIR } (${ process.env.BABYSIT_HOME ? `BABYSIT_HOME` : `default` })` ],
        [ `Config file`, file_status( config_path ) ],
        [ `Sessions directory`, SESSIONS_DIR ],
        [ `Clones directory`, CLONES_DIR ],
        [ `Agent configuration`, AGENTS_DIR ],
        [ `Host rc`, process.env.BABYSIT_HOST_BABYSITRC
            ? `${ process.env.BABYSIT_HOST_BABYSITRC } (inherited)`
            : file_status( join( homedir(), `.babysitrc` ) ) ],
        [ `Workspace config`, file_status( join( process.cwd(), `babysit.yaml` ) ) ],
        [ `Tmux socket`, TMUX_SOCKET ],
        [ `Docker image`, get_image_name() ],
        [ `Web bridge directory`, web.root ],
        [ `Web access file`, file_status( web.access ) ],
        [ `Recovery unit`, recovery.unit ],
        [ `Recovery installed`, recovery.installed === null ? `unknown` : recovery.installed ? `yes` : `no` ],
        [ `Recovery enablement`, recovery.enabled ],
        [ `Recovery state`, recovery.active === `unknown` ? `unknown (systemd unavailable or inaccessible)` : recovery.active ],
        [ `Menu default agent`, defaults.agent ],
        [ `Menu default mode`, defaults.mode ],
        [ `Menu default flags`, `yolo ${ toggle( defaults.yolo ) }, clone ${ toggle( defaults.clone ) }, loop ${ toggle( defaults.loop ) }, Docker access ${ toggle( defaults.docker ) }` ],
    ]

    output.write( `\nbabysit config\n\n${ rows.map( ( [ label, value ] ) => `${ `${ label }:`.padEnd( 24 ) }${ value }` ).join( `\n` ) }\n\n` )
    output.write( `Boot recovery setup: babysit recover init (Ubuntu/systemd)\n` )
    output.write( `Startup authentication: active agent plus supported host-installed CLIs, with concurrent misses and a 12-hour auth-input-bound success cache\n` )
    output.write( `Explicit checks: babysit doctor --auth [agent|all]\n` )
    output.write(
        `Legacy authentication selection: ${ format_auth_check_agents( current_config.auth_check_agents ) } (deprecated and ignored)\n`
    )

}
