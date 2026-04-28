import { claude_patterns } from './claude.js'
import { codex_patterns } from './codex.js'
import { gemini_patterns } from './gemini.js'
import { opencode_patterns } from './opencode.js'

/**
 * Pattern registry — maps agent name to plan/choice regex sets
 */
export const patterns = {
    claude: claude_patterns,
    codex: codex_patterns,
    gemini: gemini_patterns,
    opencode: opencode_patterns,
}

/**
 * Get patterns for an agent by name
 * @param {string} agent_name - The agent name
 * @returns {Object|null} { plan: RegExp[], choice: RegExp[] } or null
 */
export const get_patterns = ( agent_name ) => patterns[ agent_name ] || null
