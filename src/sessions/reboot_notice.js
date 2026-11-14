import { hostname } from 'os'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { wait } from 'mentie'
import { list_stored_sessions } from './store.js'
import { recovery_candidates, REBOOT_NOTICE, REBOOT_GRACE_MS } from './recovery.js'
import { list_sessions } from '../tmux/session.js'
import { send_text } from '../tmux/send.js'

// A notice starts a turn; monitors poll every second, so this is ample for
// them to publish `running` before an idle reading is trusted.
const SETTLE_MS = 10_000
const POLL_MS = 5_000

// logind's broadcast before a shutdown; newer versions also send a
// WithMetadata twin, hence firing once and exiting.
const SHUTDOWN_SIGNAL = /\.PrepareForShutdown(WithMetadata)? \(true\b/
const LOGIND_MONITOR = [ `monitor`, `--system`, `--dest`, `org.freedesktop.login1`, `--object-path`, `/org/freedesktop/login1` ]

// Typing into these would answer a dialog, race a continuation, or go nowhere
const UNSETTLED_CONTINUATION = [ `pending`, `sending`, `blocked` ]

/**
 * Pick the sessions a reboot notice can safely be typed into.
 * @param {Object[]} sessions - Stored session records
 * @param {Object[]} live - Live tmux sessions, as `list_sessions` returns them
 * @returns {Object[]} Stored sessions to notify
 */
export const notice_targets = ( sessions, live ) => {

    const status = new Map( live.map( ( { name, agent_status } ) => [ name, agent_status ] ) )

    return recovery_candidates( sessions ).filter( session => session.expected_open
        && session.host === hostname()
        && status.has( session.tmux_session )
        // `waiting` is an open dialog: pasted text plus Enter would answer it
        && status.get( session.tmux_session ) !== `waiting`
        && !session.frozen_at
        && session.status !== `preparing`
        && !UNSETTLED_CONTINUATION.includes( session.continuation ) )

}

/**
 * Tell every live agent the host is going down, then wait for them to wrap up.
 * Runs before shutdown starts, so tmux, monitors and containers are all alive.
 * @param {Object} [options] - Seams for tests
 * @param {number} [options.grace_ms] - Longest wait for agents to go idle
 * @returns {Promise<number>} How many sessions were notified
 */
export const announce_reboot = async ( {
    load = list_stored_sessions,
    live = list_sessions,
    send = send_text,
    wait_fn = wait,
    now = Date.now,
    grace_ms = REBOOT_GRACE_MS,
    print = console.log,
} = {} ) => {

    const deadline = now() + grace_ms
    const targets = notice_targets( load(), await live() )

    // Paste everywhere at once: the grace period is shared, not per session
    const deliveries = await Promise.all( targets.map( ( { tmux_session } ) => send( tmux_session, REBOOT_NOTICE )
        .then( () => tmux_session )
        .catch( error => print( `Reboot notice failed for ${ tmux_session }: ${ error.message }` ) ) ) )
    const notified = new Set( deliveries.filter( Boolean ) )
    print( `Reboot notice sent to ${ notified.size } of ${ targets.length } sessions` )
    if( !notified.size ) return 0

    // A turn that just ended reads idle for a moment before a queued notice
    // starts the next one, so only two quiet readings in a row count as done.
    await wait_fn( SETTLE_MS )
    let quiet_polls = 0
    while( now() < deadline && quiet_polls < 2 ) {
        const busy = ( await live() ).filter( ( { name, agent_status } ) => notified.has( name ) && agent_status === `running` )
        quiet_polls = busy.length ? 0 : quiet_polls + 1
        if( quiet_polls < 2 ) await wait_fn( POLL_MS )
    }

    print( quiet_polls < 2 ? `Grace period over; some agents were still working` : `All notified agents are idle` )
    return notified.size

}

/**
 * Service entry point: wait for logind to announce a shutdown, notify, exit.
 * The unit wraps this in `systemd-inhibit --mode=delay`, so the shutdown is
 * held until this process exits.
 * @param {Object} [options] - Seams for tests
 * @returns {Promise<void>}
 */
export const cmd_reboot_notice = async ( {
    listen = () => spawn( `gdbus`, LOGIND_MONITOR, { stdio: [ `ignore`, `pipe`, `inherit` ] } ),
    announce = announce_reboot,
    print = console.log,
} = {} ) => {

    const listener = listen()
    print( `Waiting for a shutdown announcement` )

    try {
        for await ( const line of createInterface( { input: listener.stdout } ) ) {
            if( !SHUTDOWN_SIGNAL.test( line ) ) continue
            // A failed notice must never hold the shutdown longer than needed
            await announce().catch( error => print( `Reboot notice failed: ${ error.message }` ) )
            return
        }
    } finally {
        // Drop the pipe too: a lingering reader would keep this process, and
        // with it the delay lock, alive after the notice is done.
        listener.kill()
        listener.stdout.destroy()
    }

    // Exit nonzero so systemd restarts the watcher instead of leaving none
    throw new Error( `Lost the logind signal listener` )

}
