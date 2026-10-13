import { closeSync, lstatSync, openSync, rmSync } from 'fs'
import { join } from 'path'

import { log } from '../utils/log.js'
import { collect_usage } from '../docker/assets/usage/command.mjs'
import { web_bridge_paths, WEB_BRIDGE_DIR, WEB_BRIDGE_PROTOCOL } from './paths.js'
import { write_atomic_json } from './files.js'

export const ACCOUNT_USAGE_FILENAME = `account-usage.json`

// Every monitor offers to refresh; the file's age and a lock make it one fetch per window.
export const ACCOUNT_USAGE_REFRESH_MS = 5 * 60_000
const LOCK_STALE_MS = 2 * 60_000

const MAX_TEXT = 200
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu

const text = value => typeof value === `string` ? value.replace( UNSAFE_TEXT, `` ).slice( 0, MAX_TEXT ) : null
const number = value => typeof value === `number` && Number.isFinite( value ) ? value : null
const amount = value => number( value ) ?? text( value )

/**
 * Allowlist one provider limit for the web container; nothing else leaves the host.
 * @param {Object} limit - Limit from collect_usage
 * @returns {Object} Display-safe limit
 */
const safe_limit = limit => ( {
    name: text( limit.name ) || `limit`,
    unit: text( limit.unit ),
    used_percent: number( limit.used_percent ),
    remaining_percent: number( limit.remaining_percent ),
    used: amount( limit.used ),
    limit: amount( limit.limit ),
    remaining: amount( limit.remaining ),
    unlimited: limit.unlimited === true,
    resets_at: text( limit.resets_at ),
} )

/**
 * Shape a usage report for the bridge state directory.
 * @param {Object} report - collect_usage result
 * @returns {Object} Bridge account usage document
 */
export const account_usage_document = report => ( {
    protocol: WEB_BRIDGE_PROTOCOL,
    kind: `account_usage`,
    fetched_at: text( report.fetched_at ),
    agents: ( report.agents || [] ).map( agent => ( {
        agent: text( agent.agent ) || `agent`,
        provider: text( agent.provider ),
        status: [ `ok`, `unavailable`, `unauthenticated`, `error` ].includes( agent.status ) ? agent.status : `error`,
        message: text( agent.message ),
        limits: ( agent.limits || [] ).slice( 0, 12 ).map( safe_limit ),
    } ) ),
} )

const age_ms = ( path, now ) => {
    try {
        return now - lstatSync( path ).mtimeMs
    } catch {
        return Infinity
    }
}

/**
 * Refresh the shared account usage file when it is older than one window.
 * Monitors run on the host with read-only credential access; Codex's
 * app-server fallback is skipped because it may rotate tokens without the
 * host authentication lease.
 * @param {Object} [options]
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 * @param {Function} [options.collect=collect_usage] - Usage collector seam
 * @param {Function} [options.now=Date.now] - Clock seam
 * @returns {Promise<boolean>} Whether this call wrote a fresh file
 */
export const refresh_account_usage = async ( {
    directory = WEB_BRIDGE_DIR,
    collect = collect_usage,
    now = Date.now,
} = {} ) => {

    const { state } = web_bridge_paths( directory )
    const path = join( state, ACCOUNT_USAGE_FILENAME )
    const lock_path = `${ path }.lock`

    if( age_ms( path, now() ) < ACCOUNT_USAGE_REFRESH_MS ) return false

    // A crashed monitor must not freeze usage forever.
    if( age_ms( lock_path, now() ) > LOCK_STALE_MS ) rmSync( lock_path, { force: true } )

    let lock
    try {
        lock = openSync( lock_path, `wx`, 0o600 )
    } catch {
        return false
    }

    try {
        // Another monitor may have refreshed between our age check and the lock.
        if( age_ms( path, now() ) < ACCOUNT_USAGE_REFRESH_MS ) return false

        const report = await collect( {
            codex_read: async () => {
                throw new Error( `Run babysit usage on the host for Codex app-server limits` )
            },
        } )
        write_atomic_json( path, account_usage_document( report ) )
        return true
    } catch ( error ) {
        log.debug( `Could not refresh web account usage: ${ error.message }` )
        return false
    } finally {
        closeSync( lock )
        rmSync( lock_path, { force: true } )
    }

}
