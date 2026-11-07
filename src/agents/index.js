import { claude } from './claude.js'
import { codex } from './codex.js'
import { opencode } from './opencode.js'

/**
 * Agent registry — maps agent name to adapter
 */
const agents = {
    claude,
    codex,
    opencode,
}

/**
 * List of supported agent names
 */
export const SUPPORTED_AGENTS = Object.keys( agents )

/**
 * Get an agent adapter by name
 * @param {string} name - Agent name (claude, codex, opencode)
 * @returns {Object|null} Agent adapter or null if unknown
 */
export const get_agent = ( name ) => agents[ name ] || null

/**
 * Check if a name is a known agent
 * @param {string} name - Name to check
 * @returns {boolean}
 */
export const is_agent = ( name ) => Object.hasOwn( agents, name )

// Agents babysit no longer runs. Old session records may still name them.
const RETIRED_AGENTS = { gemini: `Gemini CLI`, antigravity: `Antigravity`, agy: `Antigravity` }

/**
 * Explain why a retired agent (or its stored session) cannot launch
 * @param {string} name - Agent name from the command line or a session record
 * @returns {string|null} User-facing message, or null for a non-retired name
 */
export const retired_agent_message = ( name ) => Object.hasOwn( RETIRED_AGENTS, name || `` )
    ? `${ RETIRED_AGENTS[ name ] } support was removed from babysit; its sessions cannot be resumed. Start a new session with ${ SUPPORTED_AGENTS.join( `, ` ) }.`
    : null
