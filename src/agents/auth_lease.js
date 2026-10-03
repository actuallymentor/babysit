import { get_boot_id } from '../sessions/lock.js'
import { randomUUID } from 'crypto'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs'
import { dirname, join } from 'path'

import { BABYSIT_DIR } from '../utils/paths.js'
import { log } from '../utils/log.js'

export const HOST_AUTH_LEASE_PATH = join( BABYSIT_DIR, `host-auth-check.lease` )
export const HOST_AUTH_LEASE_TIMEOUT_MS = 8 * 60 * 1_000
export const HOST_AUTH_LEASE_STALE_MS = 90_000
// A waiting foreground launch keeps this marker fresh; background checks
// watch it and cancel their probe so the launch never waits a whole probe.
export const HOST_AUTH_LEASE_WANTED_STALE_MS = 5_000
export const host_auth_lease_wanted_path = ( lease_path = HOST_AUTH_LEASE_PATH ) => `${ lease_path }.wanted`

const wait = milliseconds => new Promise( resolve => setTimeout( resolve, milliseconds ) )

const process_is_alive = ( pid, kill = process.kill.bind( process ) ) => {

    if( !Number.isInteger( pid ) || pid <= 0 ) return null

    try {
        kill( pid, 0 )
        return true
    } catch ( error ) {
        return error.code === `ESRCH` ? false : true
    }

}

const read_lease_owner = lease_path => {

    try {
        return JSON.parse( readFileSync( join( lease_path, `owner.json` ), `utf-8` ) )
    } catch {
        return null
    }

}

const lease_is_stale = ( lease_path, {
    now,
    stale_ms,
    kill,
} ) => {

    const owner = read_lease_owner( lease_path )
    const boot_id = get_boot_id()
    if( owner?.boot_id && boot_id && owner.boot_id !== boot_id ) return true

    const alive = process_is_alive( owner?.pid, kill )
    if( alive === false ) return true
    if( alive === true ) return false

    try {
        return now() - statSync( lease_path ).mtimeMs >= stale_ms
    } catch {
        return false
    }

}

const try_create_lease = ( lease_path, token ) => {

    // Publish a complete owner record atomically. A crash while preparing the
    // candidate cannot leave an owner-less lease that blocks every launcher.
    const candidate_path = `${ lease_path }.candidate-${ token }`

    try {
        mkdirSync( candidate_path, { mode: 0o700 } )
        writeFileSync( join( candidate_path, `owner.json` ), JSON.stringify( {
            pid: process.pid,
            boot_id: get_boot_id(),
            token,
            acquired_at: new Date().toISOString(),
        } ), { mode: 0o600 } )
        renameSync( candidate_path, lease_path )
        return true
    } catch ( error ) {
        rmSync( candidate_path, { recursive: true, force: true } )
        if( [ `EEXIST`, `ENOTEMPTY` ].includes( error.code ) ) return false
        throw error
    }

}

const remove_stale_lease = ( lease_path, lease_options ) => {

    const takeover_path = `${ lease_path }.stale-${ randomUUID() }`
    const takeover_lock = `${ lease_path }.takeover`
    let owns_takeover = false

    try {
        mkdirSync( takeover_lock, { mode: 0o700 } )
        owns_takeover = true

        // Another waiter may have reclaimed the old lease and a new owner may
        // have acquired it since our first observation. Recheck while stale
        // takeover is serialized so that new owner can never be renamed away.
        if( !lease_is_stale( lease_path, lease_options ) ) return false

        renameSync( lease_path, takeover_path )
        rmSync( takeover_path, { recursive: true, force: true } )
        return true
    } catch ( error ) {
        rmSync( takeover_path, { recursive: true, force: true } )
        if( !owns_takeover && error.code === `EEXIST` ) {
            try {
                const age = lease_options.now() - statSync( takeover_lock ).mtimeMs
                if( age >= lease_options.stale_ms ) {
                    rmSync( takeover_lock, { recursive: true, force: true } )
                }
            } catch { /* another waiter already recovered it */ }
        }
        return false
    } finally {
        if( owns_takeover ) rmSync( takeover_lock, { recursive: true, force: true } )
    }

}

const touch_wanted_marker = lease_path => {
    try {
        writeFileSync( host_auth_lease_wanted_path( lease_path ), String( process.pid ), { mode: 0o600 } )
    } catch { /* The marker is advisory; waiting still works without it. */ }
}

const clear_wanted_marker = lease_path => rmSync( host_auth_lease_wanted_path( lease_path ), { force: true } )

/**
 * Whether a foreground launch is currently waiting for the lease.
 * @param {Object} [options]
 * @param {string} [options.lease_path] - Atomic lease directory
 * @param {Function} [options.now] - Clock seam
 * @returns {boolean} True while a fresh wanted marker exists
 */
export const is_host_auth_lease_wanted = ( {
    lease_path = HOST_AUTH_LEASE_PATH,
    now = Date.now,
    stale_ms = HOST_AUTH_LEASE_WANTED_STALE_MS,
} = {} ) => {

    try {
        return now() - statSync( host_auth_lease_wanted_path( lease_path ) ).mtimeMs < stale_ms
    } catch {
        return false
    }

}

/**
 * Serialize all-agent authentication across Babysit processes.
 * The lease begins before credential capture, so a waiting launch observes a
 * leader's reconciled refresh token and warm cache instead of probing the same
 * one-use credential concurrently.
 *
 * @param {Object} [options]
 * @param {string} [options.lease_path] - Atomic lease directory
 * @param {number} [options.timeout_ms] - Max wait for another launch
 * @param {number} [options.stale_ms] - Unknown-owner takeover age
 * @param {number} [options.poll_ms] - Wait interval
 * @param {Function} [options.now] - Clock seam
 * @param {Function} [options.wait_fn] - Async wait seam
 * @param {Function} [options.kill] - Process liveness seam
 * @param {Function} [options.on_wait] - Called once when another process holds the lease
 * @param {boolean} [options.foreground=true] - Keep the wanted marker fresh while waiting so background checks yield
 * @returns {Promise<{ release: Function }>} Owned lease
 */
export const acquire_host_auth_lease = async ( {
    lease_path = HOST_AUTH_LEASE_PATH,
    timeout_ms = HOST_AUTH_LEASE_TIMEOUT_MS,
    stale_ms = HOST_AUTH_LEASE_STALE_MS,
    poll_ms = 100,
    now = Date.now,
    wait_fn = wait,
    kill = process.kill.bind( process ),
    on_wait = () => {},
    foreground = true,
} = {} ) => {

    const token = randomUUID()
    const deadline = now() + timeout_ms
    let waited = false

    mkdirSync( dirname( lease_path ), { recursive: true } )

    try {
        while( true ) {
            if( try_create_lease( lease_path, token ) ) break

            const lease_options = { now, stale_ms, kill }
            if( lease_is_stale( lease_path, lease_options )
                && remove_stale_lease( lease_path, lease_options ) ) continue

            if( now() >= deadline ) throw new Error( `Timed out waiting for another authentication check` )
            if( !waited ) on_wait()
            waited = true
            if( foreground ) touch_wanted_marker( lease_path )
            await wait_fn( Math.min( poll_ms, Math.max( 0, deadline - now() ) ) )
        }
    } finally {
        if( waited && foreground ) clear_wanted_marker( lease_path )
    }

    let released = false

    return {
        release: () => {
            if( released ) return true
            released = true

            try {
                const owner = read_lease_owner( lease_path )
                if( owner?.token !== token ) {
                    log.warn( `Authentication lease ownership changed before release.` )
                    return false
                }

                rmSync( lease_path, { recursive: true, force: true } )
                return !existsSync( lease_path )
            } catch {
                log.warn( `Authentication lease could not be released cleanly.` )
                return false
            }
        },
    }

}
