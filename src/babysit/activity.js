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

// An open turn whose pane has not moved this long is presumed over: Claude
// fires no hook on an Escape interrupt, and a hook can die. Running agents
// redraw a spinner/timer every second, so real work never sits this still.
export const OPEN_TURN_STALE_S = 120

/**
 * Whether launch events say a turn is in progress right now.
 * @param {Object|null} turn - launch_channel turn() state
 * @param {number} idle_seconds - Seconds since visible output last changed
 * @returns {boolean}
 */
export const turn_running = ( turn, idle_seconds ) => turn?.state === `open` && idle_seconds < OPEN_TURN_STALE_S

/**
 * Activity, by precedence:
 * 1. Explicit pane controls (approval dialog → idle, interrupt hint → running,
 *    background work → waiting): what the person sees wins (gotcha 130).
 * 2. Launch events, only from a producer that reports turn starts: an open,
 *    fresh turn is running even while the pane sits still (silent tools).
 * 3. Pane stability: no events (old containers/images), stale or
 *    permission-blocked turns, and closed turns. A closed turn does not force
 *    idle: its successor's turn_started can lag the pane by one poll.
 * @param {string} output - Current visible tmux pane
 * @param {string} agent_name - Native agent name
 * @param {number} idle_seconds - Seconds since visible output last changed
 * @param {Object|null} [turn=null] - Event turn state with `reports_turns`
 * @returns {'idle'|'running'|'waiting'} Current activity
 */
export const agent_status = ( output, agent_name, idle_seconds, turn = null ) => {

    const shown = agent_activity( output, agent_name )
    if( shown ) return shown

    if( turn?.reports_turns && turn_running( turn, idle_seconds ) ) return `running`

    return idle_seconds >= 1 ? `idle` : `running`

}
