import { randomUUID } from 'crypto'
import { closeSync, existsSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from 'fs'
import { join } from 'path'

import { log } from '../utils/log.js'
import { collect_usage } from '../docker/assets/usage/command.mjs'
import { claude_account_entries } from '../cli/claude_accounts.js'
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
        // Claude subscription name when two or more accounts exist
        account: text( agent.account ),
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
 * host authentication lease. A failed refresh holds the lock until stale.
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

    // A crashed monitor must not freeze usage forever. A missing lock is not stale.
    if( existsSync( lock_path ) && age_ms( lock_path, now() ) > LOCK_STALE_MS ) rmSync( lock_path, { force: true } )

    // The owner token lets release skip a lock some other monitor took over.
    const owner = randomUUID()
    let descriptor = null
    try {
        descriptor = openSync( lock_path, `wx`, 0o600 )
        writeSync( descriptor, owner )
    } catch {
        return false
    } finally {
        if( descriptor !== null ) closeSync( descriptor )
    }

    const release = () => {
        try {
            if( readFileSync( lock_path, `utf8` ) === owner ) rmSync( lock_path, { force: true } )
        } catch {
            // Already reclaimed or removed.
        }
    }

    // Another monitor may have refreshed between our age check and the lock.
    if( age_ms( path, now() ) < ACCOUNT_USAGE_REFRESH_MS ) {
        release()
        return false
    }

    try {
        // Collection reaches Codex's app-server only without an OAuth token;
        // report that as signed out rather than spawning a token-rotating CLI.
        // Claude is split per account (cached readings) when two or more exist
        const report = await collect( { codex_read: async () => null, claude_accounts: claude_account_entries() } )
        write_atomic_json( path, account_usage_document( report ) )
        release()
        return true
    } catch ( error ) {
        // Keep the lock: it expires after LOCK_STALE_MS, so failures retry on a cooldown.
        log.debug( `Could not refresh web account usage: ${ error.message }` )
        return false
    }

}
