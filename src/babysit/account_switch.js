import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'

import { log } from '../utils/log.js'
import { BABYSIT_DIR } from '../utils/paths.js'
import { notify_pushover } from '../utils/notify.js'
import { load_session, update_session } from '../sessions/store.js'
import { DEFAULT_ACCOUNT, list_claude_accounts, pick_account, probe_accounts } from '../cli/claude_accounts.js'

/*
 * When Claude says a subscription limit was hit, move the session to another
 * registered account with headroom: `babysit restart --account <next>
 * --continue` closes it, resumes the same conversation on the new token, and
 * sends the continue prompt. At most one switch per limit window per session
 * (switches carry over through resume), so two exhausted accounts never
 * ping-pong.
 */

export const SWITCH_LOG_PATH = join( BABYSIT_DIR, `account-switch.log` )

// A switch whose limit reset is unknown blocks the next one for a session window
export const SWITCH_FALLBACK_WINDOW_MS = 5 * 3600_000

const switch_window_open = ( { at, resets_at }, now ) => resets_at
    ? Date.parse( resets_at ) > now
    : now - Date.parse( at ) < SWITCH_FALLBACK_WINDOW_MS

/**
 * Decide whether and where to move a limited session. Pure.
 * @param {Object} options
 * @param {Object} options.session - Stored session (claude_account, account_switches)
 * @param {Array<Object>} options.readings - Fresh probe_accounts readings
 * @param {number} [options.now] - Epoch ms
 * @returns {{ from: string, to: string, headroom: number, resets_at: string|null }|{ skip: string, exhausted?: boolean }}
 */
export const plan_account_switch = ( { session, readings, now = Date.now() } ) => {

    const from = session.claude_account || DEFAULT_ACCOUNT
    if( ( session.account_switches || [] ).some( entry => switch_window_open( entry, now ) ) ) {
        return { skip: `this session already switched accounts in the current limit window` }
    }

    // Pane text can be a quote; the account's own headers have the final word
    const current = readings.find( reading => reading.name === from )
    if( current?.status === `ok` && current.headroom > 0 ) return { skip: `${ from } still has ${ current.headroom }% left` }

    const best = pick_account( readings.filter( reading => reading.name !== from && reading.headroom > 0 ) )
    if( !best ) return { skip: `no other Claude account has headroom`, exhausted: true }

    // The guard holds until the current account is usable again: its latest exhausted reset
    const resets = ( current?.limits || [] )
        .filter( limit => limit.used_percent >= 100 && limit.resets_at )
        .map( limit => limit.resets_at )
        .sort()
    return { from, to: best.name, headroom: best.headroom, resets_at: resets.at( -1 ) || null }

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

    const argv1 = process.argv[1] || ``
    const compiled = argv1.startsWith( `/$bunfs` ) || !argv1
    const [ bin, ...prefix ] = command || ( compiled ? [ process.execPath ] : [ process.execPath, argv1 ] )

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
 * Monitor handler for a Claude limit on screen. Re-entrant calls while one
 * runs are dropped; every outcome is logged.
 * @param {Object} session - Stored session at monitor start
 * @param {Object} [options] - Registry, probe, store, notify and spawn seams
 * @returns {Function} Async handler; resolves to the plan it acted on
 */
export const create_account_switcher = ( session, {
    list = list_claude_accounts,
    probe = probe_accounts,
    load = load_session,
    update = update_session,
    notify = notify_pushover,
    restart = spawn_account_restart,
    now = Date.now,
} = {} ) => {

    let busy = false
    let told_exhausted = false
    const skip = reason => {
        log.info( `Claude limit on screen; not switching accounts: ${ reason }` )
        return null
    }

    return async () => {

        if( busy ) return null
        busy = true

        try {

            // Single-account users see the limit as before, without log noise
            if( list().length < 2 ) return null

            // Resume needs the native id, or it would continue another conversation
            const latest = load( session.babysit_id ) || session
            if( !latest.agent_session_id ) return skip( `no native session id was captured` )
            if( latest.modifiers?.includes( `sandbox` ) ) return skip( `sandbox sessions cannot restart` )

            const plan = plan_account_switch( { session: latest, readings: await probe( list(), { max_age_ms: 0 } ), now: now() } )
            if( plan.skip ) {
                // Say so once per monitor when every account is spent
                if( !told_exhausted && plan.exhausted ) {
                    told_exhausted = true
                    await notify( { title: `Babysit`, message: `Claude limit hit in ${ latest.name || latest.babysit_id }; ${ plan.skip }.` } )
                }
                skip( plan.skip )
                return plan
            }

            // Record first: the new launch copies the history, so the guard survives the restart
            const entry = { at: new Date( now() ).toISOString(), from: plan.from, to: plan.to, resets_at: plan.resets_at }
            update( session.babysit_id, current => ( { account_switches: [ ...current.account_switches || [], entry ] } ) )
            log.info( `Claude limit hit on account ${ plan.from }; restarting session ${ session.babysit_id } on ${ plan.to } (${ plan.headroom }% left)` )
            await notify( { title: `Babysit`, message: `Claude limit hit on ${ plan.from }; moved ${ latest.name || latest.babysit_id } to ${ plan.to } (${ plan.headroom }% left).` } )
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
