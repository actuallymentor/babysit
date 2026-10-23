import { setTimeout as delay } from 'node:timers/promises'

import { log } from '../utils/log.js'
import { run } from '../utils/exec.js'
import { detect_mode } from '../utils/platform.js'
import { docker_command_prefix } from '../docker/run.js'
import { list_sessions, set_status_label } from '../tmux/session.js'
import { list_stored_sessions, load_session, session_original_workspace, update_session } from '../sessions/store.js'
import { acquire_session_lock } from '../sessions/lock.js'
import { inspect_docker_container_state } from '../docker/file_transport.js'
import { format_session_status_label, order_active_sessions, stored_by_tmux } from './list.js'
import { select_active_session } from './archive.js'
import { is_monitor_alive } from './monitor_process.js'

// How long freeze waits for the monitor to stand down: a babysit action still
// typing (segmented rules wait for the agent between messages) holds it off
const ACK_TIMEOUT_MS = 30_000
const ACK_POLL_MS = 250

// A mark this young may belong to a freeze still waiting for its ack, so
// reconciliation leaves it alone even though the container still runs
export const FREEZE_GRACE_MS = 2 * ACK_TIMEOUT_MS

// Docker refuses to pause twice or unpause a running container; both mean "already there"
const ALREADY_PATTERN = /already paused|is not paused/i

/**
 * Pause or resume a container with Docker's cgroup freezer. Every process in
 * it stops on the spot and continues where it was; nothing is killed.
 * @param {string} container - Docker id or name
 * @param {boolean} paused - Target state
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @returns {Promise<void>}
 */
export const set_container_paused = async ( container, paused, { run_command = run } = {} ) => {

    const [ command, ...prefix ] = docker_command_prefix()
    try {
        await run_command( command, [ ...prefix, paused ? `pause` : `unpause`, container ] )
    } catch ( error ) {
        if( !ALREADY_PATTERN.test( error.message ) ) throw error
    }

}

/**
 * The tmux bottom bar says FROZEN while a session is frozen.
 * @param {Object} session - Stored session
 * @param {boolean} frozen - Whether to show the marker
 * @returns {string}
 */
export const frozen_status_label = ( session, frozen ) => {
    const label = format_session_status_label( {
        name: session.name, pwd: session_original_workspace( session ), modifiers: session.modifiers,
    } )
    return frozen ? `${ label } · FROZEN` : label
}

/**
 * Sessions a selector list names: list numbers, ids or names, or `all`
 * (every live session in the wanted state). One snapshot, deduplicated.
 * @param {string[]} selectors - User input
 * @param {Object[]} active - Active tmux sessions in display order
 * @param {Object[]} stored - Stored metadata
 * @param {boolean} freeze - Direction, used by `all`
 * @returns {Object[]} Stored sessions
 */
const select_sessions = ( selectors, active, stored, freeze ) => {

    if( selectors.includes( `all` ) ) {
        const by_tmux = stored_by_tmux( stored )
        return active
            .filter( tmux => !tmux.exited )
            .map( tmux => by_tmux.get( tmux.name ) )
            .filter( session => session?.container_id && Boolean( session.frozen_at ) !== freeze )
    }

    const selected = selectors.map( selector => select_active_session( selector, active, stored ) )
    return selected.filter( ( session, index ) => selected.findIndex( other => other.babysit_id === session.babysit_id ) === index )

}

/**
 * Whether a session's frozen mark still holds. A mark is stale once Docker
 * says the container is not paused (reboot, Docker restart, outside unpause,
 * a freeze killed before its pause), unless it is young enough to be a freeze
 * in progress. When Docker cannot answer, the mark stands.
 * @param {Object} session - Latest stored session
 * @param {Object} [deps]
 * @param {Function} [deps.inspect] - Container state lookup
 * @param {Function} [deps.update] - Session record writer
 * @param {number} [deps.now] - Epoch milliseconds
 * @returns {Promise<boolean>} Whether the session is still frozen
 */
export const reconcile_frozen = async ( session, {
    inspect = inspect_docker_container_state,
    update = update_session,
    now = Date.now(),
} = {} ) => {

    if( !session?.frozen_at ) return false
    if( now - Date.parse( session.frozen_at ) < FREEZE_GRACE_MS ) return true

    let state
    try {
        state = await inspect( session.container_id )
    } catch ( error ) {
        log.debug( `Frozen state unknown for ${ session.babysit_id }: ${ error.message }` )
        return true
    }
    if( state === `paused` ) return true

    // Clear only the mark that was inspected: an unfreeze and a fresh freeze
    // may have replaced it meanwhile, and the current record decides then
    let still_frozen = false
    update( session.babysit_id, current => {
        if( current.frozen_at !== session.frozen_at ) {
            still_frozen = Boolean( current.frozen_at )
            return null
        }
        log.info( `Session ${ session.babysit_id } is no longer paused; clearing its frozen mark` )
        return { frozen_at: null, frozen_ack: null }
    } )
    return still_frozen

}

/**
 * Wait until the session's monitor confirms it stopped touching the pane for
 * this freeze. No live monitor means nobody to wait for.
 * @param {string} babysit_id - Session id
 * @param {string} frozen_at - The mark this freeze wrote
 * @param {Object} deps - load, monitor_alive and wait seams
 * @returns {Promise<boolean>} Whether it is safe to pause
 */
const monitor_stood_down = async ( babysit_id, frozen_at, { load, monitor_alive, wait_fn } ) => {

    for( let waited = 0; waited <= ACK_TIMEOUT_MS; waited += ACK_POLL_MS ) {
        const latest = load( babysit_id )
        if( latest?.frozen_ack === frozen_at ) return true
        if( !monitor_alive( latest?.monitor_pid, latest?.monitor_token, { boot_id: latest?.boot_id } ) ) return true
        await wait_fn( ACK_POLL_MS )
    }
    return false

}

/**
 * Take a session's freeze lock without blocking the event loop, so other
 * sessions in the same batch keep moving (and release their locks) meanwhile.
 * @param {string} babysit_id - Session id
 * @param {Object} deps - lock_fn and wait_fn seams
 * @returns {Promise<Function>} Release
 */
const take_lock = async ( babysit_id, { lock_fn, wait_fn } ) => {

    for( let waited = 0; ; waited += ACK_POLL_MS ) {
        try {
            return lock_fn( babysit_id )
        } catch ( error ) {
            if( waited >= 2 * ACK_TIMEOUT_MS ) throw new Error( `another freeze or unfreeze is still working on it`, { cause: error } )
            await wait_fn( ACK_POLL_MS )
        }
    }

}

/**
 * `babysit freeze` / `babysit unfreeze`: pause session containers in place and
 * resume them later, mid-turn included. Host only, Docker sessions only.
 *
 * Each session transitions under its own lock. Freeze marks the record, waits
 * for the monitor to acknowledge it stood down (no idle nudges, watchdog
 * verdicts, dialog answers or action segments typed into a frozen pane), then
 * pauses. Unfreeze resumes first, then clears the mark so the monitor restarts
 * its timers against a live agent. An interrupted freeze rolls its marks back;
 * monitors reconcile any mark Docker no longer backs (see reconcile_frozen).
 * @param {Object} cmd - Parsed command { verb, session_ids }
 * @param {Object} [deps]
 * @returns {Promise<number>} Exit code
 */
export const cmd_freeze = async ( cmd, {
    mode = detect_mode,
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    load_session_fn = load_session,
    update_session_fn = update_session,
    lock_fn = id => acquire_session_lock( id, { namespace: `freeze` } ),
    monitor_alive = is_monitor_alive,
    pause_fn = set_container_paused,
    label_fn = set_status_label,
    wait_fn = delay,
    print = message => console.log( message ),
} = {} ) => {

    const freeze = cmd.verb === `freeze`

    // Inside a session there is no Docker daemon to ask, and it would freeze itself
    if( mode() === `container` ) throw new Error( `babysit ${ cmd.verb } runs on the host; this is a babysit container (see babysit mode)` )

    const stored = list_stored_sessions_fn()
    const active = order_active_sessions( await list_sessions_fn(), stored )
    const selected = select_sessions( cmd.session_ids, active, stored, freeze )
    const label = session => session.name || session.babysit_id

    if( !selected.length ) {
        print( freeze ? `No running Docker sessions to freeze.` : `No frozen sessions.` )
        return 0
    }

    // Marks written but not yet backed by a pause; an interrupt rolls them back
    const unbacked = new Set()
    const roll_back = () => unbacked.forEach( id => update_session_fn( id, { frozen_at: null, frozen_ack: null } ) )
    const on_signal = signal => {
        roll_back()
        process.exit( signal === `SIGINT` ? 130 : 143 )
    }
    const signals = [ `SIGINT`, `SIGTERM`, `SIGHUP` ]
    signals.forEach( signal => process.on( signal, on_signal ) )

    const transition = async session => {

        // Containerless sessions run as host processes: no cgroup freezer to use
        if( !session.container_id ) {
            print( `${ label( session ) } runs without Docker; only Docker sessions can be frozen.` )
            return false
        }

        let release = () => {}
        let pausing = false
        try {

            release = await take_lock( session.babysit_id, { lock_fn, wait_fn } )

            // Another freeze or unfreeze may have run while this one waited
            const latest = load_session_fn( session.babysit_id ) || session
            if( Boolean( latest.frozen_at ) === freeze ) {
                print( `${ label( session ) } is already ${ freeze ? `frozen` : `running` }.` )
                return true
            }

            if( freeze ) {
                const frozen_at = new Date().toISOString()
                unbacked.add( session.babysit_id )
                update_session_fn( session.babysit_id, { frozen_at, frozen_ack: null } )
                if( !await monitor_stood_down( session.babysit_id, frozen_at, { load: load_session_fn, monitor_alive, wait_fn } ) ) {
                    throw new Error( `its monitor is still running a babysit action; try again shortly` )
                }
                // Docker may pause before the call returns: from here on an
                // interrupt keeps the mark, and reconciliation settles it
                unbacked.delete( session.babysit_id )
                pausing = true
                await pause_fn( session.container_id, true )
            } else {
                await pause_fn( session.container_id, false )
                update_session_fn( session.babysit_id, { frozen_at: null, frozen_ack: null } )
            }

        } catch ( error ) {
            // A freeze that did not happen must not leave the monitor standing down
            if( unbacked.delete( session.babysit_id ) || pausing ) update_session_fn( session.babysit_id, { frozen_at: null, frozen_ack: null } )
            print( `Could not ${ cmd.verb } ${ label( session ) }: ${ error.message }` )
            return false
        } finally {
            release()
        }

        await label_fn( session.tmux_session, frozen_status_label( session, freeze ) ).catch( error => log.debug( `Could not refresh the tmux label: ${ error.message }` ) )
        print( freeze
            ? `Froze ${ label( session ) }; babysit unfreeze resumes it where it left off.`
            : `Unfroze ${ label( session ) }.` )
        return true

    }

    try {
        // Sessions are independent: wait for their monitors side by side
        const results = await Promise.all( selected.map( transition ) )
        return results.every( Boolean ) ? 0 : 1
    } finally {
        signals.forEach( signal => process.off( signal, on_signal ) )
    }

}
