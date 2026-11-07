/**
 * Codex screen knowledge: activity only. Codex model/effort go over its
 * app-server RPC, so it has no native terminal controller.
 */

/**
 * Activity from Codex's composer, once the shared interrupt scan found nothing.
 * @param {{ lines: string[], footer: string }} pane - Last 8 ANSI-free rows, and joined
 * @returns {'idle'|'waiting'|null}
 */
const activity = ( { lines, footer } ) => {

    // A turn can end while a shell it started keeps running. The native
    // line sits right above the composer; tool output quoting it does not:
    // "1 background terminal running · /ps to view · /stop to close"
    const composer = lines.findLastIndex( line => /^\s*›/.test( line ) )
    const above = lines.slice( 0, Math.max( composer, 0 ) ).findLast( line => line.trim() )
    if( /^\s*[1-9]\d* background terminals? running · \/ps to view\b/.test( above || `` ) ) return `waiting`
    if( /^\s*›\s*(?:Ask Codex to do anything|Ask a follow-up question)\s*$/m.test( footer )
        || /^\s*\?\s+for shortcuts\b/m.test( footer ) ) return `idle`
    return null

}

export const codex_screen = {

    // Approval controls also say Escape, but await the user
    approval: /^\s*Press enter to confirm or esc to (?:cancel|go back)\s*$/i,
    activity,

}
