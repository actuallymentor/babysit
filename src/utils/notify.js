import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { BABYSIT_DIR } from './paths.js'
import { log } from './log.js'

const PUSHOVER_URL = `https://api.pushover.net/1/messages.json`
export const USAGE_ALERT_PERCENT = 90
export const ALERTS_PATH = join( BABYSIT_DIR, `alerts.json` )

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
 * Used share of one limit. Codex individual limits report remaining instead,
 * and money budgets (OpenRouter) only report used against limit.
 * @param {Object} limit - Normalised usage limit
 * @returns {number|null} Percent used, or null when the limit has no share
 */
export const used_percent = limit => {
    if( Number.isFinite( limit.used_percent ) ) return limit.used_percent
    if( Number.isFinite( limit.remaining_percent ) ) return 100 - limit.remaining_percent
    if( Number.isFinite( limit.used ) && Number.isFinite( limit.limit ) && limit.limit > 0 ) return limit.used / limit.limit * 100
    return null
}

// { usage: { "<agent>/<provider>/<limit>": "<resets_at>" },
//   logouts: { "<agent>": { login: "<authenticated_at>", delivered: bool } } }
const read_alerts = path => {
    try {
        const parsed = JSON.parse( readFileSync( path, `utf8` ) ) || {}
        return { usage: parsed.usage || {}, logouts: parsed.logouts || {} }
    } catch {
        return { usage: {}, logouts: {} }
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
 * Providers that failed to report keep their state, so a fetch error
 * cannot cause a repeat alert once they recover.
 * @param {Object} usage - collect_usage() result
 * @param {Object} [options] - State path and notifier seams
 * @returns {Promise<string[]>} Keys of limits that were notified
 */
export const alert_high_usage = async ( usage, { alerts_path = ALERTS_PATH, notify = notify_pushover } = {} ) => {

    const alerts = read_alerts( alerts_path )
    const reported = new Set( ( usage?.agents || [] )
        .filter( entry => entry.status === `ok` )
        .map( entry => `${ entry.agent }/${ entry.provider }/` ) )
    const next = Object.fromEntries( Object.entries( alerts.usage )
        .filter( ( [ key ] ) => ![ ...reported ].some( prefix => key.startsWith( prefix ) ) ) )
    const sent = []

    for( const entry of usage?.agents || [] ) {
        if( entry.status !== `ok` ) continue

        for( const limit of entry.limits || [] ) {

            const used = used_percent( limit )
            if( used === null || used < USAGE_ALERT_PERCENT ) continue

            const key = `${ entry.agent }/${ entry.provider }/${ limit.name }`
            const window = limit.resets_at || `open`
            if( alerts.usage[ key ] === window ) {
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

    write_alerts( alerts_path, { ...read_alerts( alerts_path ), usage: next } )
    return sent

}

/**
 * Notify once per lost login. Each logout is keyed by the login it ended
 * (the cache entry's authenticated_at), so a re-probe of the same dead login
 * stays silent, and an undelivered alert is retried on every later run.
 * @param {{ agent: string, login: string }[]} logouts - Newly observed logouts
 * @param {Object} [options] - State path and notifier seams
 * @returns {Promise<string[]>} Agents whose logout alert was delivered
 */
export const alert_logouts = async ( logouts, { alerts_path = ALERTS_PATH, notify = notify_pushover } = {} ) => {

    const alerts = read_alerts( alerts_path )
    for( const { agent, login } of logouts ) {
        if( alerts.logouts[ agent ]?.login !== login ) alerts.logouts[ agent ] = { login, delivered: false }
    }

    const sent = []
    for( const [ agent, logout ] of Object.entries( alerts.logouts ) ) {
        if( logout.delivered ) continue

        logout.delivered = await notify( {
            title: `Babysit: ${ agent } logged out`,
            message: `${ agent } was authenticated but its latest check failed authentication. Log in again on the host.`,
        } )
        if( logout.delivered ) sent.push( agent )
    }

    write_alerts( alerts_path, { ...read_alerts( alerts_path ), logouts: alerts.logouts } )
    return sent

}
