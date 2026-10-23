import { setTimeout as delay } from 'node:timers/promises'

import { log } from '../utils/log.js'
import { run } from '../utils/exec.js'
import { detect_mode } from '../utils/platform.js'
import { docker_command_prefix } from '../docker/run.js'
import { list_sessions, set_status_label } from '../tmux/session.js'
import { list_stored_sessions, session_original_workspace, update_session } from '../sessions/store.js'
import { format_session_status_label, order_active_sessions, stored_by_tmux } from './list.js'
import { select_active_session } from './archive.js'

// The monitor reads frozen_at once per tick (1s); give an in-flight tick time
// to finish before the pause, so nothing it types lands in a frozen pane
const MONITOR_SETTLE_MS = 1_500

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
 * `babysit freeze` / `babysit unfreeze`: pause session containers in place and
 * resume them later, mid-turn included. Host only, Docker sessions only.
 *
 * Freeze marks the record first so the monitor stands down (no idle nudges,
 * watchdog verdicts or dialog answers queued into a frozen pane), then pauses.
 * Unfreeze resumes first, then clears the mark so the monitor restarts its
 * timers against a live agent. Freezing ends at reboot or Docker restart; the
 * next monitor start drops a stale mark.
 * @param {Object} cmd - Parsed command { verb, session_ids }
 * @param {Object} [deps]
 * @returns {Promise<number>} Exit code
 */
export const cmd_freeze = async ( cmd, {
    mode = detect_mode,
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    update_session_fn = update_session,
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

    // Containerless sessions run as host processes: no cgroup freezer to use
    const docker = selected.filter( session => {
        if( session.container_id ) return true
        print( `${ label( session ) } runs without Docker; only Docker sessions can be frozen.` )
        return false
    } )
    const pending = docker.filter( session => {
        if( Boolean( session.frozen_at ) !== freeze ) return true
        print( `${ label( session ) } is already ${ freeze ? `frozen` : `running` }.` )
        return false
    } )

    if( freeze && pending.length ) {
        pending.forEach( session => update_session_fn( session.babysit_id, { frozen_at: new Date().toISOString() } ) )
        await wait_fn( MONITOR_SETTLE_MS )
    }

    let failed = docker.length < selected.length

    for( const session of pending ) {

        try {
            await pause_fn( session.container_id, freeze )
        } catch ( error ) {
            // A freeze that did not happen must not leave the monitor standing down
            if( freeze ) update_session_fn( session.babysit_id, { frozen_at: null } )
            print( `Could not ${ cmd.verb } ${ label( session ) }: ${ error.message }` )
            failed = true
            continue
        }

        if( !freeze ) update_session_fn( session.babysit_id, { frozen_at: null } )
        await label_fn( session.tmux_session, frozen_status_label( session, freeze ) ).catch( error => log.debug( `Could not refresh the tmux label: ${ error.message }` ) )
        print( freeze
            ? `Froze ${ label( session ) }; babysit unfreeze resumes it where it left off.`
            : `Unfroze ${ label( session ) }.` )

    }

    return failed ? 1 : 0

}
