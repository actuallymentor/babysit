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

export const HOST_AUTH_LEASE_PATH = join( BABYSIT_DIR, `host-auth-check.lease` )
export const HOST_AUTH_LEASE_TIMEOUT_MS = 2 * 60 * 1_000
export const HOST_AUTH_LEASE_STALE_MS = 5 * 60 * 1_000

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
    const alive = process_is_alive( owner?.pid, kill )
    try {
        if( now() - statSync( lease_path ).mtimeMs >= stale_ms ) return true
    } catch {
        return false
    }
    if( alive === false ) return true
    if( alive === true ) return false

    return false

}

const remove_stale_lease = lease_path => {

    const takeover_path = `${ lease_path }.stale-${ randomUUID() }`

    try {
        renameSync( lease_path, takeover_path )
        rmSync( takeover_path, { recursive: true, force: true } )
        return true
    } catch {
        rmSync( takeover_path, { recursive: true, force: true } )
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
} = {} ) => {

    const token = randomUUID()
    const deadline = now() + timeout_ms

    mkdirSync( dirname( lease_path ), { recursive: true } )

    while( true ) {
        try {
            mkdirSync( lease_path, { mode: 0o700 } )
            writeFileSync( join( lease_path, `owner.json` ), JSON.stringify( {
                pid: process.pid,
                token,
                acquired_at: new Date().toISOString(),
            } ), { mode: 0o600 } )
            break
        } catch ( error ) {
            if( error.code !== `EEXIST` ) {
                rmSync( lease_path, { recursive: true, force: true } )
                throw error
            }

            if( lease_is_stale( lease_path, { now, stale_ms, kill } ) ) {
                remove_stale_lease( lease_path )
                continue
            }

            if( now() >= deadline ) throw new Error( `Timed out waiting for another authentication check` )
            await wait_fn( Math.min( poll_ms, Math.max( 0, deadline - now() ) ) )
        }
    }

    let released = false

    return {
        release: () => {
            if( released ) return true
            released = true

            try {
                const owner = read_lease_owner( lease_path )
                if( owner?.token !== token ) return false

                rmSync( lease_path, { recursive: true, force: true } )
                return !existsSync( lease_path )
            } catch {
                return false
            }
        },
    }

}
