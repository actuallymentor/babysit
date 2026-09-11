import { strip_ansi } from './matcher.js'

const SUPPORTED_AGENTS = new Set( [ `codex`, `claude`, `antigravity`, `opencode` ] )

/**
 * Read activity from the agent's visible controls, rather than transcript motion.
 * Unknown screens deliberately fall back to output stability in agent_status.
 * @param {string} output - Current visible tmux pane
 * @param {string} agent_name - Native agent name
 * @returns {'idle'|'running'|null} Activity when a known control is visible
 */
export const agent_activity = ( output, agent_name ) => {

    if( !SUPPORTED_AGENTS.has( agent_name ) ) return null

    // Ignore trailing blank rows and old transcript text above the controls.
    // Interrupt hints remain present while a tool waits without printing output.
    const lines = strip_ansi( output ).trimEnd().split( `\n` ).slice( -8 )
    const footer = lines.join( `\n` )
    const interrupt = /(?:^\s*|[·•(]\s*|\s{2,})esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel|stop)\b/i

    // The newest explicit control wins if an older dialog or working line is
    // still visible. Approval controls also say Escape but await user input.
    for( const line of lines.toReversed() ) {
        if( agent_name === `codex`
            && /^\s*Press enter to confirm or esc to (?:cancel|go back)\s*$/i.test( line ) ) return `idle`
        if( agent_name === `claude`
            && /^\s*Esc to cancel\s*·\s*Tab to amend\b/i.test( line ) ) return `idle`
        if( interrupt.test( line ) ) return `running`
    }

    switch ( agent_name ) {
    case `codex`:
        if( /^\s*›\s*(?:Ask Codex to do anything|Ask a follow-up question)\s*$/m.test( footer )
            || /^\s*\?\s+for shortcuts\b/m.test( footer ) ) return `idle`
        break

    case `claude`:
        if( /^\s*\?\s+for shortcuts\b/m.test( footer ) ) return `idle`
        break

    case `antigravity`:
        if( /^\s*>\s*$/m.test( footer ) && /^\s*\?\s+for shortcuts\b/m.test( footer ) ) return `idle`
        break

    case `opencode`:
        if( /^\s*tab\s+agents\s+ctrl\+p\s+commands\s*$/m.test( footer ) ) return `idle`
        break
    }

    return null

}

/**
 * Prefer agent controls over pane stability, which includes decorative redraws.
 * @param {string} output - Current visible tmux pane
 * @param {string} agent_name - Native agent name
 * @param {number} idle_seconds - Seconds since visible output last changed
 * @returns {'idle'|'running'} Current activity
 */
export const agent_status = ( output, agent_name, idle_seconds ) =>
    agent_activity( output, agent_name ) || ( idle_seconds >= 1 ? `idle` : `running` )
