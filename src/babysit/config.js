import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { BABYSIT_DIR } from '../utils/paths.js'

export const BABYSIT_CONFIG_PATH = join( BABYSIT_DIR, `config.json` )
export const DEFAULT_AUTH_CHECK_AGENTS = [ `codex`, `claude` ]

/**
 * Normalise auth-check agent names while preserving user-selected order.
 * @param {string[]} agent_names - Agent names from config or CLI input
 * @param {Object} [options]
 * @param {string[]} [options.supported_agents] - Allowed agent names
 * @returns {string[]} Valid, unique agent names
 */
export const normalise_auth_check_agents = ( agent_names = DEFAULT_AUTH_CHECK_AGENTS, {
    supported_agents = SUPPORTED_AGENTS,
} = {} ) => {

    if( !Array.isArray( agent_names ) ) return [ ...DEFAULT_AUTH_CHECK_AGENTS ]

    const seen = new Set()

    return agent_names
        .map( name => String( name ).trim().toLowerCase() )
        .filter( Boolean )
        .filter( name => supported_agents.includes( name ) )
        .filter( name => {
            if( seen.has( name ) ) return false

            seen.add( name )
            return true
        } )

}

/**
 * Build the default host-level Babysit config.
 * @returns {{ version: number, auth_check_agents: string[] }} Default config
 */
export const default_babysit_config = () => ( {
    version: 1,
    auth_check_agents: [ ...DEFAULT_AUTH_CHECK_AGENTS ],
} )

/**
 * Read host-level Babysit config from ~/.babysit/config.json.
 * @param {Object} [options]
 * @param {string} [options.config_path] - Config file path
 * @returns {{ version: number, auth_check_agents: string[] }} Parsed config
 */
export const read_babysit_config = ( {
    config_path = BABYSIT_CONFIG_PATH,
} = {} ) => {

    try {
        if( !existsSync( config_path ) ) return default_babysit_config()

        const parsed = JSON.parse( readFileSync( config_path, `utf-8` ) )
        const auth_check_agents = Object.hasOwn( parsed || {}, `auth_check_agents` )
            ? parsed.auth_check_agents
            : DEFAULT_AUTH_CHECK_AGENTS

        return {
            version: 1,
            auth_check_agents: normalise_auth_check_agents( auth_check_agents ),
        }
    } catch {
        return default_babysit_config()
    }

}

/**
 * Write host-level Babysit config to disk.
 * @param {Object} config - Partial config values
 * @param {Object} [options]
 * @param {string} [options.config_path] - Config file path
 * @returns {{ version: number, auth_check_agents: string[] }} Saved config
 */
export const write_babysit_config = ( config = {}, {
    config_path = BABYSIT_CONFIG_PATH,
} = {} ) => {

    const next_config = {
        version: 1,
        auth_check_agents: normalise_auth_check_agents( config.auth_check_agents ),
    }

    mkdirSync( dirname( config_path ), { recursive: true } )
    writeFileSync( config_path, `${ JSON.stringify( next_config, null, 2 ) }\n` )

    return next_config

}
