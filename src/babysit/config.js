import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, isAbsolute, join, resolve } from 'path'

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

// Native agent transcripts (subagents included) are mirrored here unless turned off
export const DEFAULT_TRANSCRIPT_ARCHIVE = join( BABYSIT_DIR, `transcripts` )

/**
 * Normalise the transcript archive setting: an absolute host path, or false.
 * `~` expands, relative paths resolve against the working directory, and
 * off/false/none disable it. Missing or junk values fall back to the default.
 * @param {*} value - Config or CLI value
 * @returns {string|false} Archive directory, or false when disabled
 */
export const normalise_transcript_archive = value => {

    if( value === false ) return false
    if( typeof value !== `string` || !value.trim() ) return DEFAULT_TRANSCRIPT_ARCHIVE

    const raw = value.trim()
    if( /^(off|false|none|disabled?)$/i.test( raw ) ) return false
    if( /^(on|true|default)$/i.test( raw ) ) return DEFAULT_TRANSCRIPT_ARCHIVE

    const expanded = raw === `~` || raw.startsWith( `~/` ) ? join( homedir(), raw.slice( 1 ) ) : raw
    return isAbsolute( expanded ) ? expanded : resolve( expanded )

}

/**
 * Build the default host-level Babysit config.
 * @returns {{ version: number, auth_check_agents: string[], auto_update: boolean, transcript_archive: string|false }} Default config
 */
export const default_babysit_config = () => ( {
    version: 1,
    auth_check_agents: [ ...DEFAULT_AUTH_CHECK_AGENTS ],
    auto_update: false,
    transcript_archive: DEFAULT_TRANSCRIPT_ARCHIVE,
} )

/**
 * Read host-level Babysit config from the selected storage root.
 * @param {Object} [options]
 * @param {string} [options.config_path] - Config file path
 * @returns {{ version: number, auth_check_agents: string[], auto_update: boolean, transcript_archive: string|false }} Parsed config
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
            auto_update: parsed?.auto_update === true,
            transcript_archive: normalise_transcript_archive( parsed?.transcript_archive ),
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
 * @returns {{ version: number, auth_check_agents: string[], auto_update: boolean, transcript_archive: string|false }} Saved config
 */
export const write_babysit_config = ( config = {}, {
    config_path = BABYSIT_CONFIG_PATH,
} = {} ) => {

    // Partial writes keep every other setting: `babysit config` and `update --auto` share this file
    const merged = { ...read_babysit_config( { config_path } ), ...config }
    const next_config = {
        version: 1,
        auth_check_agents: normalise_auth_check_agents( merged.auth_check_agents ),
        auto_update: merged.auto_update === true,
        transcript_archive: normalise_transcript_archive( merged.transcript_archive ),
    }

    // The default stays implicit, so it follows BABYSIT_HOME instead of pinning today's path
    const { transcript_archive, ...stored } = next_config
    const saved = transcript_archive === DEFAULT_TRANSCRIPT_ARCHIVE ? stored : next_config

    mkdirSync( dirname( config_path ), { recursive: true } )
    writeFileSync( config_path, `${ JSON.stringify( saved, null, 2 ) }\n` )

    return next_config

}
