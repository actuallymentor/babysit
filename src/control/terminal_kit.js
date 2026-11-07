import { setTimeout as wait } from 'node:timers/promises'

/*
 * Shared pieces of native TUI control. Each agent's own screen knowledge
 * (pickers, dialogs, composer) lives in src/agents/screens/<agent>.js.
 */

const POLL_MS = 100

// The host retries CONTROL_PENDING once the screen is safe again
export const pending = message => Object.assign( new Error( message ), { code: `CONTROL_PENDING` } )
export const unsupported = message => Object.assign( new Error( message ), { code: `CONTROL_UNSUPPORTED` } )

// Compare names loosely: `Opus 5.5` ~ `opus-5-5`
export const clean = value => value.toLowerCase().replace( /[^a-z0-9]/g, `` )

// A live dialog sits at the bottom; older transcript text stays above this
export const pane_tail = ( screen, rows = 35 ) => screen.split( `\n` ).slice( -rows ).join( `\n` )

/**
 * Poll the pane until it satisfies a predicate.
 * @param {Function} capture - Async pane capture
 * @param {Function} predicate - Screen test
 * @param {number} timeout_ms - Deadline
 * @returns {Promise<string>} The matching screen
 */
export const wait_for = async ( capture, predicate, timeout_ms ) => {
    const deadline = Date.now() + timeout_ms
    while( Date.now() < deadline ) {
        const screen = await capture()
        if( predicate( screen ) ) return screen
        await wait( POLL_MS )
    }
    throw new Error( `Agent control timed out waiting for its native UI.` )
}
