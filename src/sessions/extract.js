/**
 * Try to extract an agent session ID from pane output
 * @param {string} output - Cleaned pane output
 * @param {RegExp} pattern - Agent-specific session ID regex with capture group
 * @returns {string|null} The captured session ID, or null
 */
export const extract_session_id = ( output, pattern ) => {

    const match = output.match( pattern )
    return match ? match[1] : null

}
