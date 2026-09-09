import { createHash, randomUUID } from 'crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { SESSIONS_DIR } from '../utils/paths.js'

/** Identify a Linux boot; unavailable identity never proves a lock stale. */
export const get_boot_id = () => {

    try {
        return readFileSync( `/proc/sys/kernel/random/boot_id`, `utf8` ).trim() || null
    } catch {
        return null
    }

}

/** Linux process start ticks distinguish a reused PID from its original owner. */
export const get_process_identity = ( pid = process.pid ) => {

    try {
        const stat = readFileSync( `/proc/${ pid }/stat`, `utf8` )
        return stat.slice( stat.lastIndexOf( `)` ) + 2 ).split( /\s+/ )[ 19 ] || null
    } catch {
        return null
    }

}

/** Return true only when a same-host owner is demonstrably gone. */
export const lock_owner_is_stale = owner => {

    if( !owner || owner.hostname !== hostname() || !Number.isSafeInteger( owner.pid ) || owner.pid <= 0 ) return false

    const boot_id = get_boot_id()
    if( owner.boot_id && boot_id && owner.boot_id !== boot_id ) return true

    try {
        process.kill( owner.pid, 0 )
    } catch ( error ) {
        return error.code === `ESRCH`
    }

    const identity = get_process_identity( owner.pid )
    return Boolean( owner.process_identity && identity && owner.process_identity !== identity )

}

/** Flush a file or directory before reporting a durable lifecycle transition. */
export const sync_path = path => {

    const descriptor = openSync( path, `r` )
    try {
        fsyncSync( descriptor )
    } finally {
        closeSync( descriptor )
    }

}

const remove_owner = ( path, token ) => {

    // The token is the filename: competing stale removers cannot unlink the
    // next owner's record. Never recursively remove a published lock directory.
    rmSync( join( path, `${ token }.json` ), { force: true } )
    try {
        rmdirSync( path )
    } catch ( error ) {
        if( ![ `ENOENT`, `ENOTEMPTY`, `EEXIST` ].includes( error.code ) ) throw error
    }

}

const reclaim_lock = path => {

    try {
        if( !lstatSync( path ).isDirectory() ) return false
        const files = readdirSync( path )
        if( files.length === 0 ) {
            // An empty published directory can only be a interrupted release.
            rmdirSync( path )
            return true
        }
        if( files.length !== 1 ) return false

        const owner = JSON.parse( readFileSync( join( path, files[ 0 ] ), `utf8` ) )
        if( !owner.token || files[ 0 ] !== `${ owner.token }.json` || !lock_owner_is_stale( owner ) ) return false
        remove_owner( path, owner.token )
        return true
    } catch ( error ) {
        return error.code === `ENOENT`
    }

}

/**
 * Serialize lifecycle work. The returned release function can span awaits.
 * Store merges use a separate namespace so lifecycle holders can update records.
 * @param {string} key - Shared agent/workspace or session identifier
 * @param {Object} [options]
 * @param {string} [options.directory] - Registry root
 * @param {string} [options.namespace] - Lifecycle or short record-write lock
 * @param {number} [options.wait_ms] - Synchronous contention deadline; default fail-fast
 * @returns {Function} Idempotent release with a diagnostic .path property
 */
export const acquire_session_lock = ( key, { directory = SESSIONS_DIR, namespace = `lifecycle`, wait_ms = 0 } = {} ) => {

    const locks = join( directory, `.locks` )
    mkdirSync( locks, { recursive: true, mode: 0o700 } )
    const hash = createHash( `sha256` ).update( `${ namespace }:${ key }` ).digest( `hex` )
    const path = join( locks, hash )
    const token = randomUUID()
    const candidate = join( locks, `.pending-${ token }` )
    const owner = { token, pid: process.pid, hostname: hostname(), boot_id: get_boot_id(), process_identity: get_process_identity() }
    const deadline = Date.now() + wait_ms

    // Rename a populated directory: it cannot replace another populated lock.
    // Unlike mkdir + owner write, this never publishes an ownerless acquisition.
    mkdirSync( candidate, { mode: 0o700 } )
    try {
        const owner_path = join( candidate, `${ token }.json` )
        writeFileSync( owner_path, JSON.stringify( owner ), { mode: 0o600 } )
        sync_path( owner_path )
        sync_path( candidate )

        while( true ) {
            try {
                renameSync( candidate, path )
                sync_path( locks )
                break
            } catch ( error ) {
                if( ![ `ENOTEMPTY`, `EEXIST` ].includes( error.code ) ) throw error
                if( reclaim_lock( path ) ) continue
                if( Date.now() >= deadline ) {
                    const busy = new Error( `Session operation already in progress: ${ key }` )
                    busy.code = `BABYSIT_SESSION_LOCKED`
                    throw busy
                }
                Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, 10 )
            }
        }
    } finally {
        rmSync( candidate, { recursive: true, force: true } )
    }

    let released = false
    const release = () => {

        if( released ) return
        remove_owner( path, token )
        sync_path( locks )
        released = true

    }
    release.path = path
    return release

}
