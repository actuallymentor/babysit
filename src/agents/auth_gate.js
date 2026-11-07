import { readFileSync } from 'fs'

import { get_agent, SUPPORTED_AGENTS } from './index.js'
import { resolve_host_auth_context_files, resolve_host_auth_context_values } from './auth.js'
import {
    credential_mounts_for_agent,
    find_host_auth_cache_hit,
    fingerprint_agent_credentials,
    resolve_auth_image_identity,
} from './auth_cache.js'

/*
 * Launch-time authentication gate: local evidence only, no model call. Each
 * adapter's `credentials.gate` judges what this launch stages for it:
 *
 *   usable       a login that works as staged
 *   refreshable  expired access, but the agent refreshes it itself (Codex)
 *   unknown      cannot tell locally (OpenCode free models, no token expiry)
 *   missing      nothing to log in with
 *
 * Only `missing` stops a launch. Real prompts stay with `doctor --auth` and
 * the scheduled `auth check`.
 */

export const AUTH_GATE_STATES = [ `usable`, `refreshable`, `unknown`, `missing` ]

/**
 * Collect what a launch stages for one agent, without secrets leaving memory.
 * @param {Object} agent - Agent adapter
 * @param {Object[]} mounts - Every staged credential descriptor
 * @param {Object} [options]
 * @param {string|null} [options.route] - Configured Claude route (API key, Bedrock, ...)
 * @param {number} [options.now] - Clock
 * @param {Function} [options.read_file] - Reader seam
 * @returns {{ file: string|null, env: boolean, account: Object|null, route: string|null, now: number }}
 */
export const launch_auth_evidence = ( agent, mounts = [], {
    route = null,
    now = Date.now(),
    read_file = path => readFileSync( path, `utf8` ),
} = {} ) => {

    const own = credential_mounts_for_agent( agent, mounts )
    const file_mount = own.find( mount => mount.target === agent.container_paths?.creds && mount.source )
    const account_mount = own.find( mount => mount.type === `account_env` )

    let file = null
    try {
        if( file_mount ) file = read_file( file_mount.source )
    } catch {
        file = null
    }

    return {
        file,
        env: own.some( mount => [ `env`, `secret_env` ].includes( mount.type ) ),
        account: account_mount ? { name: account_mount.account, expires_at: account_mount.expires_at || null } : null,
        route,
        now,
    }

}

/**
 * Judge one agent's staged login locally.
 * @param {Object} agent - Agent adapter
 * @param {Object[]} mounts - Every staged credential descriptor
 * @param {Object} [options] - launch_auth_evidence options
 * @returns {'usable'|'refreshable'|'unknown'|'missing'} Gate state
 */
export const local_auth_state = ( agent, mounts = [], options = {} ) => {

    const gate = agent?.credentials?.gate
    if( typeof gate !== `function` ) return `unknown`

    const state = gate( launch_auth_evidence( agent, mounts, options ) )
    return AUTH_GATE_STATES.includes( state ) ? state : `unknown`

}

/**
 * Cache trust this launch inherits, without probing: every agent whose staged
 * credentials match a fresh verified cache entry. The monitor re-stamps these
 * entries when the session rotates a token, so the checker stays warm.
 * @param {Object} active - Launched agent adapter (receives agent_args)
 * @param {Object[]} mounts - Every staged credential descriptor
 * @param {Object} options - Launch context plus cache seams
 * @returns {Promise<Object>} name → { credential_fingerprint, credential_parts, image_identity }
 */
export const launch_auth_cache_contexts = async ( active, mounts = [], {
    workspace,
    mode = {},
    agent_args = [],
    agents = SUPPORTED_AGENTS.map( get_agent ).filter( Boolean ),
    resolve_image_identity = resolve_auth_image_identity,
    resolve_context_files = resolve_host_auth_context_files,
    resolve_context_values = resolve_host_auth_context_values,
    cache_options = {},
} = {} ) => {

    const identities = agents
        .map( agent => [ agent.name, fingerprint_agent_credentials( agent, mounts, {
            context_files: resolve_context_files( mode, { agent } ),
            context_values: resolve_context_values( agent, agent.name === active.name ? agent_args : [], {
                workspace,
                include_host_preferences: !mode.ignore_host_agents_md,
            } ),
        } ) ] )
        .filter( ( [ , identity ] ) => identity )
    if( !identities.length ) return {}

    const image_identity = await resolve_image_identity()
    if( !image_identity ) return {}

    return Object.fromEntries( identities
        .filter( ( [ name, identity ] ) => find_host_auth_cache_hit( name, {
            credential_fingerprint: identity.fingerprint,
            image_identity,
        }, cache_options ) )
        .map( ( [ name, identity ] ) => [ name, {
            credential_fingerprint: identity.fingerprint,
            credential_parts: identity.parts,
            image_identity,
        } ] ) )

}
