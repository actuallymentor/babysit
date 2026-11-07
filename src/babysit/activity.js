import { get_agent } from '../agents/index.js'
import { strip_ansi } from './matcher.js'

// Interrupt hints remain present while a tool waits without printing output
const INTERRUPT = /(?:^\s*|[·•(]\s*|\s{2,})esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel|stop)\b/i

/**
 * Read activity from the agent's visible controls, rather than transcript motion.
 * Each adapter's `screen` reads its own footer; unknown screens deliberately
 * fall back to output stability in agent_status.
 * @param {string} output - Current visible tmux pane
 * @param {string} agent_name - Native agent name
 * @returns {'idle'|'running'|'waiting'|null} Activity when a known control is visible
 */
export const agent_activity = ( output, agent_name ) => {

    const rules = get_agent( agent_name )?.screen
    if( !rules?.activity ) return null

    // Ignore trailing blank rows and old transcript text above the controls
    const screen = strip_ansi( output ).trimEnd().split( `\n` )
    const lines = screen.slice( -8 )

    // The newest explicit control wins if an older dialog or working line is
    // still visible. Approval controls also say Escape but await user input.
    for( const line of lines.toReversed() ) {
        if( rules.approval?.test( line ) ) return `idle`
        if( INTERRUPT.test( line ) ) return `running`
    }

    return rules.activity( { screen, lines, footer: lines.join( `\n` ) } )

}

/**
 * Prefer agent controls over pane stability, which includes decorative redraws.
 * @param {string} output - Current visible tmux pane
 * @param {string} agent_name - Native agent name
 * @param {number} idle_seconds - Seconds since visible output last changed
 * @returns {'idle'|'running'|'waiting'} Current activity
 */
export const agent_status = ( output, agent_name, idle_seconds ) =>
    agent_activity( output, agent_name ) || ( idle_seconds >= 1 ? `idle` : `running` )
