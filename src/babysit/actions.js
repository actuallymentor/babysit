import { execSync } from 'child_process'
import { wait } from 'mentie'

import { log } from '../utils/log.js'
import { send_text, send_enter, send_shift_tab } from '../tmux/send.js'
import { load_markdown_segments, split_segments } from './segments.js'
import { IdleTracker, strip_ansi } from './matcher.js'
import { capture_pane } from '../tmux/capture.js'

// Debounce for idle-wait between segments (seconds)
const SEGMENT_IDLE_THRESHOLD_S = 30
const SEGMENT_POLL_INTERVAL_MS = 2_000

/**
 * Execute a `do:` action from a babysit rule
 * @param {string} session_name - The tmux session name
 * @param {*} action - The do: value from the rule
 * @param {Object} config - The babysit config section
 * @returns {Promise<void>}
 */
export const execute_action = async ( session_name, action, config ) => {

    const action_str = String( action ).trim()

    // Special keywords
    if( action_str === `enter` ) {
        log.info( `Action: pressing Enter` )
        await send_enter( session_name )
        return
    }

    if( action_str === `shift_tab` || action_str === `accept` ) {
        log.info( `Action: pressing Shift+Tab (accept)` )
        await send_shift_tab( session_name )
        return
    }

    // Named command from config.commands
    if( config.commands?.[ action_str ] ) {
        log.info( `Action: running command '${ action_str }'` )
        try {
            execSync( config.commands[ action_str ], { stdio: `inherit`, shell: true } )
        } catch ( e ) {
            log.error( `Command '${ action_str }' failed: ${ e.message }` )
        }
        return
    }

    // Markdown file path
    if( action_str.endsWith( `.md` ) ) {
        log.info( `Action: executing markdown file ${ action_str }` )
        await execute_markdown( session_name, action_str )
        return
    }

    // String with === segments (inline multi-step instructions)
    if( action_str.includes( `===` ) ) {
        log.info( `Action: executing segmented instruction` )
        const segments = split_segments( action_str )
        await execute_segments( session_name, segments )
        return
    }

    // Plain string — send as text input
    log.info( `Action: sending text "${ action_str.slice( 0, 60 ) }"` )
    await send_text( session_name, action_str )

}

/**
 * Load and execute a markdown file as segmented instructions
 * @param {string} session_name - The tmux session name
 * @param {string} file_path - Path to the markdown file
 * @returns {Promise<void>}
 */
const execute_markdown = async ( session_name, file_path ) => {

    const segments = load_markdown_segments( file_path )
    if( !segments ) return

    await execute_segments( session_name, segments )

}

/**
 * Execute an array of segments, waiting for idle between each
 * @param {string} session_name - The tmux session name
 * @param {string[]} segments - Array of text segments
 * @returns {Promise<void>}
 */
const execute_segments = async ( session_name, segments ) => {

    for( let i = 0; i < segments.length; i++ ) {

        const segment = segments[i]
        log.debug( `Executing segment ${ i + 1 }/${ segments.length }: ${ segment.slice( 0, 60 ) }` )

        await send_text( session_name, segment )

        // Wait for idle before sending next segment (except for the last one)
        if( i < segments.length - 1 ) {
            log.debug( `Waiting for idle before next segment...` )
            await wait_for_idle( session_name )
        }

    }

}

/**
 * Wait until the tmux session output stabilises (agent is idle)
 * @param {string} session_name - The tmux session name
 * @param {number} [threshold_s=30] - Seconds of no change to consider idle
 * @param {number} [max_wait_s=600] - Maximum time to wait
 * @returns {Promise<void>}
 */
const wait_for_idle = async ( session_name, threshold_s = SEGMENT_IDLE_THRESHOLD_S, max_wait_s = 600 ) => {

    const tracker = new IdleTracker()
    const deadline = Date.now() +  max_wait_s * 1_000 

    while( Date.now() < deadline ) {

        try {
            const raw = await capture_pane( session_name )
            const clean = strip_ansi( raw )
            const idle_seconds = tracker.update( clean )

            if( idle_seconds >= threshold_s ) {
                log.debug( `Session idle for ${ idle_seconds }s, continuing` )
                return
            }
        } catch {
            // Session may have ended
            return
        }

        await wait( SEGMENT_POLL_INTERVAL_MS )

    }

    log.warn( `Idle wait timed out after ${ max_wait_s }s` )

}
