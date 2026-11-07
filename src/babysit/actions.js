import { spawn } from 'child_process'
import { wait } from 'mentie'

import { log } from '../utils/log.js'
import { send_text, send_enter } from '../tmux/send.js'
import { expand_segments, load_markdown_segments, split_segments } from './segments.js'
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
 * @param {Object} [options] - Seams and the launch channel
 * @param {Function} [options.send_enter_fn] - Enter key sender
 * @param {Object|null} [options.launch_channel] - Live turn events; segment waits end at turn_completed
 * @returns {Promise<void>}
 */
export const execute_action = async ( session_name, action, config, {
    send_enter_fn = send_enter,
    launch_channel = null,
} = {} ) => {

    const action_str = String( action ).trim()

    // The only key action: confirm whatever the agent is showing.
    if( action_str === `enter` ) {
        log.info( `Action: pressing Enter` )
        await send_enter_fn( session_name )
        return
    }

    // Named command from config.commands. Run via async spawn so a slow
    // command (curl notification, network call, etc.) doesn't freeze the
    // monitor loop — execSync would block the Node event loop, halting
    // pane capture and rule evaluation for the duration of the command.
    if( config.commands?.[ action_str ] ) {
        log.info( `Action: running command '${ action_str }'` )
        try {
            await run_shell_command( config.commands[ action_str ] )
        } catch ( e ) {
            log.error( `Command '${ action_str }' failed: ${ e.message }` )
        }
        return
    }

    // Markdown file path
    if( action_str.endsWith( `.md` ) ) {
        log.info( `Action: executing markdown file ${ action_str }` )
        const segments = load_markdown_segments( action_str, { config } )
        if( segments ) await execute_segments( session_name, segments, { launch_channel } )
        return
    }

    // String with === segments (inline multi-step instructions)
    if( action_str.includes( `===` ) ) {
        log.info( `Action: executing segmented instruction` )
        const segments = expand_segments( split_segments( action_str ), config )
        await execute_segments( session_name, segments, { launch_channel } )
        return
    }

    // Plain string — send as text input
    log.info( `Action: sending text "${ action_str.slice( 0, 60 ) }"` )
    await send_text( session_name, action_str )

}

/**
 * Run a shell command non-blocking. Resolves on success, rejects on non-zero exit.
 * Uses spawn over execSync to keep the Node event loop free for the monitor.
 * @param {string} command - Shell command string
 * @returns {Promise<void>}
 */
const run_shell_command = ( command ) => new Promise( ( resolve, reject ) => {

    const child = spawn( command, { stdio: `inherit`, shell: true } )

    child.on( `close`, code => {
        if( code === 0 ) resolve()
        else reject( new Error( `exit ${ code }` ) )
    } )

    child.on( `error`, reject )

} )

/**
 * Execute an array of segments, waiting for the agent between each
 * @param {string} session_name - The tmux session name
 * @param {string[]} segments - Array of text segments
 * @param {Object} [options] - Launch channel and seams for wait_for_idle
 * @returns {Promise<void>}
 */
export const execute_segments = async ( session_name, segments, options = {} ) => {

    const { send_text_fn = send_text } = options

    for( let i = 0; i < segments.length; i++ ) {

        const segment = segments[i]
        log.debug( `Executing segment ${ i + 1 }/${ segments.length }: ${ segment.slice( 0, 60 ) }` )

        // Mark before typing: only a turn that starts after it can end this wait
        const mark = options.launch_channel?.last_seq?.() ?? 0
        await send_text_fn( session_name, segment )

        // Wait for idle before sending next segment (except for the last one)
        if( i < segments.length - 1 ) {
            log.debug( `Waiting for idle before next segment...` )
            await wait_for_idle( session_name, { ...options, mark } )
        }

    }

}

/**
 * Whether launch events show the segment's own turn finished: a turn that
 * started after `mark` and has since completed (any status, interrupts too).
 * @param {Object|null} launch_channel - Live channel
 * @param {number} mark - Channel seq before the segment was typed
 * @returns {boolean}
 */
export const segment_turn_done = ( launch_channel, mark ) => {

    if( !launch_channel?.reports_turns?.() ) return false
    const turn = launch_channel.turn()
    return turn?.state === `closed` && turn.started_seq > mark

}

/**
 * Wait until the agent finished the segment's turn. With turn events, the
 * turn's own completion ends the wait. The pane rule (30s unchanged screen)
 * runs alongside as the fallback: no events, hooks that stop emitting, a
 * Claude Escape interrupt (no hook fires), a lost container.
 * @param {string} session_name - The tmux session name
 * @param {Object} [options]
 * @param {Object|null} [options.launch_channel] - Live turn events
 * @param {number} [options.mark=0] - Channel seq before the segment was typed
 * @param {number} [options.threshold_s=30] - Seconds of no change to consider idle
 * @param {number} [options.max_wait_s=600] - Maximum time to wait
 * @returns {Promise<'event'|'pane'|'gone'|'timeout'>} What ended the wait
 */
export const wait_for_idle = async ( session_name, {
    launch_channel = null,
    mark = 0,
    threshold_s = SEGMENT_IDLE_THRESHOLD_S,
    max_wait_s = 600,
    capture_pane_fn = capture_pane,
    wait_fn = wait,
    poll_ms = SEGMENT_POLL_INTERVAL_MS,
    now_fn = Date.now,
} = {} ) => {

    const tracker = new IdleTracker( now_fn )
    const deadline = now_fn() + max_wait_s * 1_000

    while( now_fn() < deadline ) {

        launch_channel?.tick?.( { eager: true } )
        if( segment_turn_done( launch_channel, mark ) ) {
            log.debug( `Segment turn completed (${ launch_channel.turn().status }), continuing` )
            return `event`
        }

        try {
            const raw = await capture_pane_fn( session_name )
            const idle_seconds = tracker.update( strip_ansi( raw ) )

            if( idle_seconds >= threshold_s ) {
                log.debug( `Session idle for ${ idle_seconds }s, continuing` )
                return `pane`
            }
        } catch {
            // Session may have ended
            return `gone`
        }

        await wait_fn( poll_ms )

    }

    log.warn( `Idle wait timed out after ${ max_wait_s }s` )
    return `timeout`

}
