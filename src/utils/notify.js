import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BABYSIT_DIR } from './paths.js'
import { log } from './log.js'

const PUSHOVER_URL = `https://api.pushover.net/1/messages.json`
export const USAGE_ALERT_PERCENT = 90
export const USAGE_ALERTS_PATH = join( BABYSIT_DIR, `usage-alerts.json` )

/**
 * Whether Pushover credentials are present. Without them every notifier is
 * a no-op, so callers can skip work (like usage fetches) that only feeds one.
 * @param {Object} [env=process.env] - Environment
 * @returns {boolean} True when both PUSHOVER_TOKEN and PUSHOVER_USER are set
 */
export const pushover_configured = ( env = process.env ) => Boolean( env.PUSHOVER_TOKEN && env.PUSHOVER_USER )

/**
 * Send one Pushover notification. Never throws: a notification outage must
 * not fail the job that raised it.
 * @param {Object} message - { title, message }
 * @param {Object} [options] - Environment and fetch seams
 * @returns {Promise<boolean>} True when Pushover accepted the message
 */
export const notify_pushover = async ( { title, message }, { env = process.env, fetch_fn = fetch } = {} ) => {

    if( !pushover_configured( env ) ) return false

    try {
        const response = await fetch_fn( PUSHOVER_URL, {
            method: `POST`,
            body: new URLSearchParams( { token: env.PUSHOVER_TOKEN, user: env.PUSHOVER_USER, title, message } ),
            signal: AbortSignal.timeout( 10_000 ),
        } )
        if( !response.ok ) log.warn( `Pushover rejected the notification (HTTP ${ response.status })` )
        return response.ok
    } catch ( error ) {
        log.warn( `Pushover notification failed: ${ error.message }` )
        return false
    }

}

/**
 * Used share of one limit; Codex individual limits report remaining instead.
 * @param {Object} limit - Normalised usage limit
 * @returns {number|null} Percent used, or null when the limit has no percentage
 */
export const used_percent = limit => {
    if( Number.isFinite( limit.used_percent ) ) return limit.used_percent
    if( Number.isFinite( limit.remaining_percent ) ) return 100 - limit.remaining_percent
    return null
}

const read_alerts = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) ) || {}
    } catch {
        return {}
    }
}

const write_alerts = ( path, alerts ) => {
    mkdirSync( dirname( path ), { recursive: true } )
    const temporary_path = `${ path }.${ process.pid }.tmp`
    writeFileSync( temporary_path, `${ JSON.stringify( alerts, null, 2 ) }\n`, { mode: 0o600 } )
    renameSync( temporary_path, path )
}

/**
 * Notify once per limit window when usage crosses USAGE_ALERT_PERCENT.
 * A limit is remembered by its reset time while it stays high; dropping
 * back below the threshold or a new window (new resets_at) re-arms it.
 * @param {Object} usage - collect_usage() result
 * @param {Object} [options] - State path and notifier seams
 * @returns {Promise<string[]>} Keys of limits that were notified
 */
export const alert_high_usage = async ( usage, { alerts_path = USAGE_ALERTS_PATH, notify = notify_pushover } = {} ) => {

    const previous = read_alerts( alerts_path )
    const next = {}
    const sent = []

    for( const entry of usage?.agents || [] ) {
        for( const limit of entry.limits || [] ) {

            const used = used_percent( limit )
            if( used === null || used < USAGE_ALERT_PERCENT ) continue

            const key = `${ entry.agent }/${ entry.provider }/${ limit.name }`
            const window = limit.resets_at || `open`
            if( previous[ key ] === window ) {
                next[ key ] = window
                continue
            }

            const resets = limit.resets_at ? `, resets ${ limit.resets_at }` : ``
            const delivered = await notify( {
                title: `Babysit: ${ entry.agent } usage at ${ Math.round( used ) }%`,
                message: `${ entry.provider } limit "${ limit.name }" is ${ Math.round( used ) }% used${ resets }.`,
            } )
            // Only remember delivered alerts, so an outage retries next run
            if( delivered ) {
                next[ key ] = window
                sent.push( key )
            }

        }
    }

    write_alerts( alerts_path, next )
    return sent

}

/**
 * Notify that a previously verified agent is now logged out.
 * @param {string} agent - Agent name
 * @param {Object} [options] - Notifier seam
 * @returns {Promise<boolean>} Whether the notification was delivered
 */
export const alert_logout = ( agent, { notify = notify_pushover } = {} ) => notify( {
    title: `Babysit: ${ agent } logged out`,
    message: `${ agent } was authenticated but its latest check failed authentication. Log in again on the host.`,
} )
