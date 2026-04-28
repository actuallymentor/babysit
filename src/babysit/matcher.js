import { createHash } from 'crypto'
import { log } from '../utils/log.js'

// ANSI escape sequence patterns
// Cursor-forward \e[nC → repeat N spaces BEFORE stripping (sir-claudius v0.8.1 fix)
const CURSOR_FWD_RE = /\x1b\[(\d*)C/g
const ANSI_RE = /\x1b\[\??[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b[=>]/g

/**
 * Synchronous SHA-256 hash for idle tracking
 * @param {string} str - Input string
 * @returns {string} Hex digest
 */
const quick_hash = ( str ) => createHash( `sha256` ).update( str ).digest( `hex` )

/**
 * Strip ANSI escape sequences from text, preserving visual spacing
 * @param {string} text - Raw terminal output
 * @returns {string} Clean text
 */
export const strip_ansi = ( text ) => {

    // Replace cursor-forward \e[nC with N spaces (default 1)
    const spaced = text.replace( CURSOR_FWD_RE, ( _, n ) => ` `.repeat( parseInt( n || `1`, 10 ) ) )

    // Then strip all remaining ANSI sequences
    return spaced.replace( ANSI_RE, `` )

}

/**
 * Get the last N lines from a text block
 * @param {string} text - The full text
 * @param {number} n - Number of lines to return
 * @returns {string} Last N lines joined
 */
export const last_n_lines = ( text, n ) => {

    const lines = text.split( `\n` )
    return lines.slice( -n ).join( `\n` )

}

/**
 * Manages idle state tracking via output hashing
 */
export class IdleTracker {

    constructor() {
        this.last_hash = null
        this.unchanged_since = null
    }

    /**
     * Update with new pane output, returns seconds idle
     * @param {string} output - Cleaned pane output
     * @returns {number} Seconds since output last changed
     */
    update( output ) {

        const current_hash = quick_hash( output )
        const now = Date.now()

        if( current_hash !== this.last_hash ) {
            this.last_hash = current_hash
            this.unchanged_since = now
            return 0
        }

        return Math.floor( ( now - this.unchanged_since ) / 1_000 )

    }

    /**
     * Reset the idle tracker (e.g. after sending input)
     */
    reset() {
        this.last_hash = null
        this.unchanged_since = null
    }

    /**
     * Compute the unix-epoch deadline (seconds) at which the next idle
     * window of `timeout_s` will elapse, based on when the output last changed.
     * @param {number} timeout_s - Idle threshold in seconds
     * @returns {number|null} Epoch seconds, or null if the tracker hasn't seen output yet
     */
    get_deadline( timeout_s ) {
        if( !this.unchanged_since ) return null
        return Math.floor(  this.unchanged_since / 1_000  ) + timeout_s
    }

}

/**
 * Check if cleaned output matches any patterns in a list
 * @param {string} output - Cleaned pane output (last N lines)
 * @param {RegExp[]} patterns - Array of regex patterns to test
 * @returns {boolean} True if any pattern matches
 */
export const matches_patterns = ( output, patterns ) => {

    return patterns.some( pattern => pattern.test( output ) )

}

/**
 * Evaluate a single rule against the current pane state
 * @param {Object} rule - Parsed rule from babysit.yaml
 * @param {Object} context - { output, idle_seconds, agent_patterns, config }
 * @returns {boolean} True if the rule matches
 */
export const evaluate_rule = ( rule, context ) => {

    const { output, idle_seconds, agent_patterns, config } = context
    const { on } = rule

    switch ( on.type ) {

    case `idle`:
        return idle_seconds >= ( rule.timeout_s || config.idle_timeout_s )

    case `plan`:
        if( !agent_patterns?.plan ) return false
        return matches_patterns(
            last_n_lines( output, config.lines_for_literal_match ),
            agent_patterns.plan
        )

    case `choice`:
        if( !agent_patterns?.choice ) return false
        return matches_patterns(
            last_n_lines( output, config.lines_for_literal_match ),
            agent_patterns.choice
        )

    case `regex`:
        return on.value.test( last_n_lines( output, config.lines_for_regex_match ) )

    case `literal`: {
        const search_area = last_n_lines( output, config.lines_for_literal_match )
        return search_area.includes( on.value )
    }

    default:
        log.warn( `Unknown rule type: ${ on.type }` )
        return false

    }

}
