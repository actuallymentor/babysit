import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'

import { log } from '../utils/log.js'
import { BABYSIT_DIR } from '../utils/paths.js'
import { notify_pushover } from '../utils/notify.js'
import { load_session, update_session } from '../sessions/store.js'
import { get_session_attachment } from '../tmux/session.js'
import { resolve_checker_command } from '../cli/auth.js'
import { DEFAULT_ACCOUNT, list_claude_accounts, pick_account, probe_accounts } from '../cli/claude_accounts.js'

/*
 * When Claude says a subscription limit was hit, move the session to another
 * registered account with headroom: `babysit restart --account <next>
 * --continue` closes it, resumes the same conversation on the new token, and
 * sends the continue prompt. An account the session left in a limit window
 * that is still open is never a target again (switches carry over through
 * resume), so A→B→C works but two exhausted accounts never ping-pong.
 */

export const SWITCH_LOG_PATH = join( BABYSIT_DIR, `account-switch.log` )

// A switch whose limit reset is unknown blocks the next one for a session window
export const SWITCH_FALLBACK_WINDOW_MS = 5 * 3600_000

// Quota readings this young are trusted; the 10-minute rescan always re-reads
export const SWITCH_PROBE_MAX_AGE_MS = 60_000

// A limit line this soon after a switch is likely the resumed transcript, not a new limit
export const SPENT_NOTICE_GRACE_MS = 10 * 60_000

// A recorded switch blocks its source account until that account's limit resets
const switch_window_open = ( { at, resets_at }, now ) => resets_at
    ? Date.parse( resets_at ) > now
    : now - Date.parse( at ) < SWITCH_FALLBACK_WINDOW_MS

const open_switches = ( session, now ) => ( session.account_switches || [] ).filter( entry => switch_window_open( entry, now ) )

// Latest reset among a reading's exhausted windows: when that account is usable again
const exhausted_reset = ( limits = [] ) => limits
    .filter( limit => limit.used_percent >= 100 && limit.resets_at )
    .map( limit => limit.resets_at )
    .sort()
    .at( -1 ) || null

/**
 * When every account is spent: the earliest recorded reset of an account this
 * session left, i.e. when the first one frees up. Pure.
 * @param {Object} session - Stored session (account_switches)
 * @param {number} [now] - Epoch ms
 * @returns {{ window: string, resets_at: string|null }} window keys one spent episode
 */
export const spent_window = ( session, now = Date.now() ) => {
    const entries = open_switches( session, now )
    const [ resets_at = null ] = entries.map( entry => entry.resets_at ).filter( Boolean ).sort()
    return { window: entries.map( ( { at } ) => at ).join( `,` ), resets_at }
}

/**
 * The switch guard, checked before any probe. Pure.
 * @param {Object} options
 * @param {Object} options.session - Stored session (claude_account, account_switches)
 * @param {string[]} options.names - Registered account names
 * @param {number} [options.now] - Epoch ms
 * @returns {{ from: string, targets: string[] }|{ skip: string, spent?: true, from?: string }} spent: no target left
 */
export const switch_targets = ( { session, names, now = Date.now() } ) => {

    const from = session.claude_account || DEFAULT_ACCOUNT

    // Accounts this session already left while their limit window is still open
    const spent = new Set( open_switches( session, now ).map( ( { from: left } ) => left ) )

    // Still on an account it left: that restart has not landed yet
    if( spent.has( from ) ) return { skip: `a switch away from ${ from } is already under way` }

    const targets = names.filter( name => name !== from && !spent.has( name ) )
    if( !targets.length ) return { skip: `every other Claude account already hit its limit in this window`, spent: true, from }
    return { from, targets }

}

/**
 * Decide whether and where to move a limited session. Pure.
 * @param {Object} options
 * @param {Object} options.session - Stored session (claude_account, account_switches)
 * @param {Array<Object>} options.readings - Fresh probe_accounts readings
 * @param {number} [options.now] - Epoch ms
 * @returns {{ from: string, to: string, headroom: number, resets_at: string|null }|{ skip: string, exhausted?: boolean }}
 */
export const plan_account_switch = ( { session, readings, now = Date.now() } ) => {

    const guard = switch_targets( { session, names: readings.map( ( { name } ) => name ), now } )
    if( guard.skip ) return guard
    const { from, targets } = guard

    // Pane text can be a quote; the account's own headers have the final word
    const current = readings.find( reading => reading.name === from )
    if( current?.status === `ok` && current.headroom > 0 ) return { skip: `${ from } still has ${ current.headroom }% left` }

    const best = pick_account( readings.filter( reading => targets.includes( reading.name ) && reading.headroom > 0 ) )
    if( !best ) return { skip: `no other Claude account has headroom`, exhausted: true }

    // The guard holds until the current account is usable again: its latest exhausted reset
    return { from, to: best.name, headroom: best.headroom, resets_at: exhausted_reset( current?.limits ) }

}

/**
 * Detached `babysit restart <id> --force --detach --continue --account <to>`.
 * It outlives this monitor, which ends with the session it closes.
 * @param {string} babysit_id - Session to move
 * @param {string} account - Target account
 * @param {Object} [options] - Command, spawn and log seams
 */
export const spawn_account_restart = ( babysit_id, account, {
    command = null,
    spawn_fn = spawn,
    log_path = SWITCH_LOG_PATH,
} = {} ) => {

    // Same self-invocation the auth checker timer uses (compiled binary or bun + script)
    const [ bin, ...prefix ] = command || resolve_checker_command()

    // The restart's own output lands in one file, for when a switch goes wrong
    let output = `ignore`
    try {
        output = openSync( log_path, `a`, 0o600 )
    } catch ( error ) {
        log.debug( `Could not open ${ log_path }: ${ error.message }` )
    }

    try {
        const child = spawn_fn( bin, [ ...prefix, `restart`, babysit_id, `--force`, `--detach`, `--continue`, `--account`, account ], {
            detached: true, stdio: [ `ignore`, output, output ], env: { ...process.env },
        } )
        child.on?.( `error`, error => log.warn( `Account switch restart failed to start: ${ error.message }` ) )
        child.unref?.()
    } finally {
        if( typeof output === `number` ) closeSync( output )
    }

}

/**
 * Whether a person has the session's tmux open. Unreadable counts as detached:
 * the session is likely gone and the restart reports that itself.
 * @param {string} tmux_session - Exact tmux session name
 * @returns {Promise<boolean>}
 */
const session_attached = tmux_session => get_session_attachment( tmux_session )
    .then( state => state === `attached` )
    .catch( () => false )

/**
 * Monitor handler for a Claude limit on screen. Re-entrant calls while one
 * runs are dropped; every outcome is logged.
 * @param {Object} session - Stored session at monitor start
 * @param {Object} [options] - Registry, probe, store, attachment, notify and spawn seams
 * @returns {Function} Async handler; resolves to the plan it acted on
 */
export const create_account_switcher = ( session, {
    list = list_claude_accounts,
    probe = probe_accounts,
    load = load_session,
    update = update_session,
    attached = session_attached,
    notify = notify_pushover,
    restart = spawn_account_restart,
    now = Date.now,
} = {} ) => {

    let busy = false
    let told_exhausted = false
    let told_attached = false
    let told_spent_window = null

    const label = record => record.name || record.babysit_id
    const skip = reason => {
        log.info( `Claude limit on screen; not switching accounts: ${ reason }` )
        return null
    }

    /*
     * Every account spent: one note per window, from the recorded resets. Only
     * with no reset on record is the current account probed, once per window.
     * Right after a switch the line is likely the resumed transcript: wait.
     */
    const tell_spent = async ( latest, from, accounts ) => {

        const { window, resets_at: recorded } = spent_window( latest, now() )
        if( told_spent_window === window ) return
        const last_switch = Math.max( ...open_switches( latest, now() ).map( ( { at } ) => Date.parse( at ) ) )
        if( now() - last_switch < SPENT_NOTICE_GRACE_MS ) return
        told_spent_window = window

        const current = recorded ? null : accounts.find( ( { name } ) => name === from )
        const [ reading ] = current ? await probe( [ current ], { max_age_ms: SWITCH_PROBE_MAX_AGE_MS } ) : []
        // The headers can still overrule the pane: a quoted limit line is no news
        if( reading?.status === `ok` && reading.headroom > 0 ) return
        const resets_at = recorded || exhausted_reset( reading?.limits )
        const when = resets_at ? `resets ${ resets_at.slice( 0, 16 ).replace( `T`, ` ` ) } UTC` : `reset time unknown`

        await notify( { title: `Babysit`, message: `All Claude accounts spent in ${ label( latest ) }; ${ when }.` } )

    }

    return async () => {

        if( busy ) return null
        busy = true

        try {

            // Single-account users see the limit as before, without log noise
            const accounts = list()
            if( accounts.length < 2 ) return null
            log.info( `Pane shows a claude usage limit` )

            // Resume needs the native id, or it would continue another conversation
            const latest = load( session.babysit_id ) || session
            if( !latest.agent_session_id ) return skip( `no native session id was captured` )
            if( latest.modifiers?.includes( `sandbox` ) ) return skip( `sandbox sessions cannot restart` )

            // Guard before probing: a stale limit line in a resumed transcript costs nothing
            const guard = switch_targets( { session: latest, names: accounts.map( ( { name } ) => name ), now: now() } )
            if( guard.skip ) {
                if( guard.spent ) await tell_spent( latest, guard.from, accounts )
                skip( guard.skip )
                return guard
            }

            const candidates = accounts.filter( ( { name } ) => name === guard.from || guard.targets.includes( name ) )
            const readings = await probe( candidates, { max_age_ms: SWITCH_PROBE_MAX_AGE_MS } )
            const plan = plan_account_switch( { session: latest, readings, now: now() } )
            if( plan.skip ) {
                // Say so once per monitor when every account is spent
                if( !told_exhausted && plan.exhausted ) {
                    told_exhausted = true
                    await notify( { title: `Babysit`, message: `Claude limit hit in ${ label( latest ) }; ${ plan.skip }.` } )
                }
                skip( plan.skip )
                return plan
            }

            // Never pull the session out from under someone typing in it; later scans retry
            if( latest.tmux_session && await attached( latest.tmux_session ) ) {
                if( !told_attached ) {
                    told_attached = true
                    await notify( { title: `Babysit`, message: `Claude limit hit on ${ plan.from } in ${ label( latest ) }; detach to let babysit switch to ${ plan.to }.` } )
                }
                skip( `a client is attached; detach to let babysit switch to ${ plan.to }` )
                return { skip: `attached`, to: plan.to }
            }

            // Record first: the new launch copies the history, so the guard survives the restart
            const entry = { at: new Date( now() ).toISOString(), from: plan.from, to: plan.to, resets_at: plan.resets_at }
            update( session.babysit_id, current => ( { account_switches: [ ...current.account_switches || [], entry ] } ) )
            log.info( `Claude limit hit on account ${ plan.from }; restarting session ${ session.babysit_id } on ${ plan.to } (${ plan.headroom }% left)` )
            await notify( { title: `Babysit`, message: `Claude limit hit on ${ plan.from }; moved ${ label( latest ) } to ${ plan.to } (${ plan.headroom }% left).` } )
            restart( session.babysit_id, plan.to )
            return plan

        } catch ( error ) {
            log.warn( `Claude account switch failed: ${ error.message }` )
            return null
        } finally {
            busy = false
        }

    }

}
