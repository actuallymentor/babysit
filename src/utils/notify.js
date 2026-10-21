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

// Claude stamps every read with a fresh resets_at (sub-second drift, which can
// cross a second boundary), so windows match within a slack, not exactly
const WINDOW_SLACK_MS = 15 * 60_000

const same_window = ( a, b ) => a === b
    || Math.abs( Date.parse( a ) - Date.parse( b ) ) < WINDOW_SLACK_MS

/**
 * Notify once per limit window when usage crosses USAGE_ALERT_PERCENT, with
 * one push per run however many limits crossed. A dated window is remembered
 * until it resets, so readings that dip and recover stay silent; an open one
 * (no reset time) re-arms once it drops below the threshold. Providers that
 * failed to report keep their state, so a fetch error cannot cause a repeat.
 * @param {Object} usage - collect_usage() result
 * @param {Object} [options] - State path, notifier, and clock seams
 * @returns {Promise<string[]>} Keys of limits that were notified
 */
export const alert_high_usage = async ( usage, { alerts_path = ALERTS_PATH, notify = notify_pushover, now = Date.now() } = {} ) => {

    const alerts = read_alerts( alerts_path )
    const reported = ( usage?.agents || [] )
        .filter( entry => entry.status === `ok` )
        .map( entry => `${ entry.agent }/${ entry.provider }/` )
    const live = ( key, window ) => window === `open`
        ? !reported.some( prefix => key.startsWith( prefix ) )
        : !( Date.parse( window ) < now - WINDOW_SLACK_MS )
    const next = Object.fromEntries( Object.entries( alerts.usage ).filter( ( [ key, window ] ) => live( key, window ) ) )
    const crossed = []

    for( const entry of usage?.agents || [] ) {
        if( entry.status !== `ok` ) continue

        for( const limit of entry.limits || [] ) {

            const used = used_percent( limit )
            if( used === null || used < USAGE_ALERT_PERCENT ) continue

            const key = `${ entry.agent }/${ entry.provider }/${ limit.name }`
            const window = limit.resets_at || `open`
            if( alerts.usage[ key ] && same_window( alerts.usage[ key ], window ) ) {
                next[ key ] = alerts.usage[ key ]
                continue
            }
            crossed.push( { key, window, agent: entry.agent, used, line: `${ entry.provider } limit "${ limit.name }" is ${ Math.round( used ) }% used${ limit.resets_at ? `, resets ${ limit.resets_at }` : `` }.` } )

        }
    }

    // One push for the whole run, titled by the fullest limit
    const top = crossed.reduce( ( max, limit ) => limit.used > ( max?.used ?? -1 ) ? limit : max, null )
    const agents = new Set( crossed.map( limit => limit.agent ) )
    const delivered = top && await notify( {
        title: `Babysit: ${ agents.size === 1 ? `${ top.agent } ` : `` }usage at ${ Math.round( top.used ) }%`,
        message: crossed.map( limit => limit.line ).join( `\n` ),
    } )
    // Only remember delivered alerts, so an outage retries next run
    if( delivered ) crossed.forEach( ( { key, window } ) => next[ key ] = window )

    write_alerts( alerts_path, { ...read_alerts( alerts_path ), usage: next } )
    return delivered ? crossed.map( limit => limit.key ) : []

}

/**
 * Whether a host logout for this agent is on record (pending or delivered).
 * Session alerts defer to it: the host alert already names the fix.
 * @param {string} agent - Agent name
 * @param {Object} [options] - State path seam
 * @returns {boolean} True while the host login is known lost
 */
export const host_logout_on_record = ( agent, { alerts_path = ALERTS_PATH } = {} ) => Boolean( read_alerts( alerts_path ).logouts[ agent ] )

/**
 * Notify once per lost login. Each logout is keyed by the login it ended
 * (the cache entry's authenticated_at), so a re-probe of the same dead login
 * stays silent, and an undelivered alert is retried on every later run.
 * Agents verified again since are recovered: their pending or delivered
 * state is dropped, so a stale "log in again" never goes out after a fix.
 * @param {{ agent: string, login: string, reason?: string }[]} logouts - Newly observed logouts
 * @param {Object} [options] - Recovered agents, state path and notifier seams
 * @returns {Promise<string[]>} Agents whose logout alert was delivered
 */
export const alert_logouts = async ( logouts, { recovered = [], alerts_path = ALERTS_PATH, notify = notify_pushover } = {} ) => {

    const alerts = read_alerts( alerts_path )
    recovered.forEach( agent => delete alerts.logouts[ agent ] )
    for( const { agent, login, reason, fix } of logouts ) {
        if( alerts.logouts[ agent ]?.login !== login ) alerts.logouts[ agent ] = { login, reason, fix, delivered: false }
    }

    const sent = []
    for( const [ agent, logout ] of Object.entries( alerts.logouts ) ) {
        if( logout.delivered ) continue

        logout.delivered = await notify( {
            title: `Babysit: ${ agent } logged out`,
            message: `${ agent } was authenticated but ${ logout.reason || `its latest check failed authentication` }. ${ logout.fix || `Log in again on the host.` }`,
        } )
        if( logout.delivered ) sent.push( agent )
    }

    write_alerts( alerts_path, { ...read_alerts( alerts_path ), logouts: alerts.logouts } )
    return sent

}
