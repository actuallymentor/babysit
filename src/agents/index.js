import { claude } from './claude.js'
import { codex } from './codex.js'
import { antigravity } from './antigravity.js'
import { opencode } from './opencode.js'

/**
 * Agent registry — maps agent name to adapter
 */
const agents = {
    claude,
    codex,
    antigravity,
    opencode,
}

/**
 * List of supported agent names
 */
export const SUPPORTED_AGENTS = Object.keys( agents )

/**
 * Get an agent adapter by name
 * @param {string} name - Agent name (claude, codex, antigravity, opencode)
 * @returns {Object|null} Agent adapter or null if unknown
 */
export const get_agent = ( name ) => agents[ name ] || null

/**
 * Check if a name is a known agent
 * @param {string} name - Name to check
 * @returns {boolean}
 */
export const is_agent = ( name ) => Object.hasOwn( agents, name )
