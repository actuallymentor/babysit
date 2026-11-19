import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { write_atomic_json } from '../web_bridge/files.js'
import { log } from '../utils/log.js'

/*
 * Remote (cold) transcript archive: a mounted share the local (hot) archive is
 * shipped to. Sessions only ever write the hot archive; shipping copies it over
 * when the share proves it is really there.
 *
 *   <remote>/.babysit-archive   identity, written once by `babysit config --transcripts-remote`
 *   <remote>/<hostname>/…       this host's volumes/, sandbox/, sessions/
 *
 * The identity can only be born on a mounted filesystem (neither the hot
 * archive's disk nor the root disk, where a bare mountpoint lives), and config
 * remembers its id. An unmounted share is an empty local directory: no
 * identity, so nothing ships. Every file re-checks the destination's device,
 * so a share unmounted mid-ship stops the copy instead of landing locally.
 * Babysit never creates the remote root.
 */

export const SENTINEL = `.babysit-archive`
const STATUS = `.ship.json`
const LOCK = `.ship.lock`

// Only what the archive itself writes ships; anything else in the hot root stays put
const SHIPPED = [ `volumes`, `sandbox`, `sessions` ]

// Shared by every monitor on the host: the status file throttles, the lock serialises
export const SHIP_INTERVAL_MS = 10 * 60_000
const SHIP_TIMEOUT_MS = 10 * 60_000

// Sandbox copies untouched this long (session gone) leave the hot archive once shipped
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000

// Credential-looking state never leaves the host, even mid-extraction before cleanup
export const SECRET_FILE = /(auth|cred|token|secret|key)[^/]*\.json$/i

// In-flight temp files from the mirror and from shipping
const PARTIAL = /\.babysit-(partial|shipping)$/

const nearest_existing = path => existsSync( path ) ? path : nearest_existing( dirname( path ) )

const read_json = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        return null
    }
}

/**
 * Whether a device is a local disk: the hot archive's or the root filesystem's.
 * @param {number} dev - Candidate device
 * @param {string} hot - Local archive root
 * @returns {boolean}
 */
const is_local_dev = ( dev, hot ) => [ nearest_existing( hot ), `/` ].some( path => statSync( path ).dev === dev )

/**
 * Bind a mounted share as the remote archive: adopt its identity, or write one.
 * @param {string} path - Absolute remote root, already mounted
 * @param {Object} options
 * @param {string} options.hot - Local archive root
 * @returns {{ path: string, id: string, adopted: boolean }}
 */
export const init_remote_archive = ( path, { hot } ) => {

    if( !existsSync( path ) || !statSync( path ).isDirectory() ) {
        throw new Error( `${ path } is not a directory. Mount the share first; Babysit never creates the remote root.` )
    }

    // Another host (or an earlier init) already named this archive
    const existing = read_json( join( path, SENTINEL ) )
    if( existing?.babysit_archive === 1 && existing.id ) return { path, id: existing.id, adopted: true }

    if( is_local_dev( statSync( path ).dev, hot ) ) {
        throw new Error( `${ path } is on a local disk (the root or the local archive's). Is the share mounted?` )
    }

    const identity = { babysit_archive: 1, id: randomUUID(), created_at: new Date().toISOString(), created_on: hostname() }
    writeFileSync( join( path, SENTINEL ), `${ JSON.stringify( identity, null, 2 ) }\n`, { flag: `wx` } )
    return { path, id: identity.id, adopted: false }

}

/**
 * Why the remote cannot take a shipment right now, or null when it can.
 * Async throughout: a dead share must not block the monitor's event loop.
 * @param {{ path: string, id: string }} remote - Configured remote
 * @param {string} hot - Local archive root
 * @returns {Promise<string|null>}
 */
export const remote_problem = async ( remote, hot ) => {

    const identity = await readFile( join( remote.path, SENTINEL ), `utf8` ).then( JSON.parse ).catch( () => null )
    if( !identity ) return `${ SENTINEL } missing (share not mounted?)`
    if( identity.id !== remote.id ) return `${ SENTINEL } belongs to another archive (${ identity.id })`
    if( is_local_dev( ( await stat( remote.path ) ).dev, hot ) ) return `on a local disk, not the share`

    return null

}

// Rejects after ms; `expired` tells the caller the work may still be running
const with_timeout = ( promise, ms, label, expired ) => {
    let timer
    const timeout = new Promise( ( _, reject ) => {
        timer = setTimeout( () => {
            expired.value = true
            reject( new Error( `${ label } timed out` ) )
        }, ms )
        timer.unref?.()
    } )
    return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) )
}

// Same size, mtime within 2 s (FAT-backed NAS shares round to 2 s)
const same_stats = ( source, target ) => target && target.size === source.size && Math.abs( target.mtimeMs - source.mtimeMs ) < 2000

/**
 * Walk a tree: [ relative path, stats ] per regular file, [ relative path, null ]
 * per entry that does not ship (symlink, temp file, credential). A missing root
 * is empty; any other read error throws, so a walk is never silently partial.
 * @param {string} root
 * @returns {AsyncGenerator<[ string, import('node:fs').Stats|null ]>}
 */
async function* entries_in( root, relative = `` ) {
    const entries = await readdir( join( root, relative ), { withFileTypes: true } )
        .catch( error => error.code === `ENOENT` && !relative ? [] : Promise.reject( error ) )
    for( const entry of entries ) {
        const path = join( relative, entry.name )
        if( entry.isDirectory() ) yield* entries_in( root, path )
        else if( entry.isFile() && !PARTIAL.test( entry.name ) && !SECRET_FILE.test( entry.name ) ) yield [ path, await stat( join( root, path ) ) ]
        else yield [ path, null ]
    }
}

/**
 * Incremental copy, mtimes kept so an unchanged file costs one stat. Before
 * each file the guard directory must still sit on the share's device. Temp
 * name + rename: a cut connection never leaves a half file under a real name.
 * @param {string} source
 * @param {string} destination - Directory on the share (created as needed)
 * @param {{ root: string, dev: number }} share - Existing directory on the share and its device
 * @returns {Promise<number>} Files copied
 */
export const copy_tree = async ( source, destination, share ) => {

    let copied = 0
    for await ( const [ path, source_stats ] of entries_in( source ) ) {

        if( !source_stats ) continue
        const target = join( destination, path )
        if( same_stats( source_stats, await stat( target ).catch( () => null ) ) ) continue

        // Unmounted since the identity check: stop before mkdir recreates the path locally
        const guard = await stat( share.root ).catch( () => null )
        if( guard?.dev !== share.dev ) throw new Error( `share left mid-ship` )

        await mkdir( dirname( target ), { recursive: true, mode: 0o700 } )
        const temporary = `${ dirname( target ) }/.${ randomUUID() }.babysit-shipping`
        try {
            await copyFile( join( source, path ), temporary )
            await utimes( temporary, source_stats.atime, source_stats.mtime )
            await rename( temporary, target )
        } finally {
            await rm( temporary, { force: true } )
        }
        copied++

    }
    return copied

}

const same_bytes = async ( a, b ) => {
    const [ left, right ] = await Promise.all( [ readFile( a ), readFile( b ).catch( () => null ) ] )
    return Boolean( right ) && left.equals( right )
}

/**
 * Drop sandbox copies from the hot archive once their session is long gone
 * (index untouched for PRUNE_AFTER_MS) and every entry is byte-identical on the
 * remote. Anything that does not ship (symlink, temp, credential) keeps it.
 * Volume mirrors stay: they track live state and would be re-copied in full.
 * @param {string} hot
 * @param {string} cold - This host's directory on the remote
 * @param {number} now - Epoch ms
 * @returns {Promise<number>} Sandboxes pruned
 */
export const prune_shipped = async ( hot, cold, now ) => {

    let pruned = 0
    const ids = await readdir( join( hot, `sandbox` ) ).catch( () => [] )
    for( const id of ids ) {

        const index = await stat( join( hot, `sessions`, `${ id }.json` ) ).catch( () => null )
        if( !index || now - index.mtimeMs < PRUNE_AFTER_MS ) continue

        const relative = join( `sandbox`, id )
        let verified = true
        for await ( const [ path, stats ] of entries_in( join( hot, relative ) ) ) {
            verified = Boolean( stats ) && await same_bytes( join( hot, relative, path ), join( cold, relative, path ) )
            if( !verified ) break
        }
        if( !verified ) continue

        await rm( join( hot, relative ), { recursive: true, force: true } )
        pruned++

    }
    return pruned

}

/**
 * Last ship outcome: { remote_id, checked_at, shipped_at, copied, pruned, error }.
 * @param {string} hot
 * @param {string} [remote_id] - Only a status for this archive counts
 * @returns {Object|null}
 */
export const read_ship_status = ( hot, remote_id ) => {
    const status = hot ? read_json( join( hot, STATUS ) ) : null
    return status && ( !remote_id || status.remote_id === remote_id ) ? status : null
}

// Lock file per hot archive; a lock older than two timeouts is a dead monitor's
const take_lock = hot => {
    const path = join( hot, LOCK )
    try {
        writeFileSync( path, `${ process.pid }\n`, { flag: `wx` } )
        return () => rmSync( path, { force: true } )
    } catch {
        // Only a stale lock is worth one retry; any other write failure skips this pass
        const lock = statSync( path, { throwIfNoEntry: false } )
        if( !lock || Date.now() - lock.mtimeMs < 2 * SHIP_TIMEOUT_MS ) return null
        rmSync( path, { force: true } )
        return take_lock( hot )
    }
}

/**
 * Ship the hot archive to the remote, at most every SHIP_INTERVAL_MS per host.
 * Never throws; the outcome lands in the status file.
 * @param {Object} options
 * @param {string|null} options.hot - Local archive root
 * @param {{ path: string, id: string }|false} options.remote - Configured remote
 * @param {number} [options.now] - Epoch ms
 * @param {string} [options.host] - This host's directory name on the remote
 * @returns {Promise<Object|null>} New status, or null when skipped
 */
export const ship_archive = async ( { hot, remote, now = Date.now(), host = hostname(), timeout_ms = SHIP_TIMEOUT_MS } ) => {

    if( !hot || !remote || !existsSync( hot ) ) return null

    const previous = read_ship_status( hot, remote.id )
    if( previous && now - previous.checked_at < SHIP_INTERVAL_MS ) return null

    const release = take_lock( hot )
    if( !release ) return null

    // A timed-out step may still be running: keep the lock until it goes stale
    const expired = { value: false }
    const bounded = ( promise, label ) => with_timeout( promise, timeout_ms, label, expired )

    let status
    try {

        const problem = await bounded( remote_problem( remote, hot ), `Remote check` )
        if( problem ) throw new Error( problem )

        // The host directory is the only one created above the walk; its parent was just verified
        const cold = join( remote.path, host )
        await bounded( mkdir( cold, { mode: 0o700 } ).catch( error => error.code === `EEXIST` || Promise.reject( error ) ), `Remote setup` )
        const share = { root: cold, dev: ( await bounded( stat( remote.path ), `Remote check` ) ).dev }

        let copied = 0
        for( const tree of SHIPPED ) copied += await bounded( copy_tree( join( hot, tree ), join( cold, tree ), share ), `Shipping` )
        const pruned = await bounded( prune_shipped( hot, cold, now ), `Pruning` )
        status = { remote_id: remote.id, checked_at: now, shipped_at: now, copied, pruned, error: null }

    } catch ( error ) {
        log.warn( `Remote transcript archive ${ remote.path }: ${ error.message }` )
        status = { ...previous, remote_id: remote.id, checked_at: now, error: error.message }
    } finally {
        if( !expired.value ) release()
    }

    try {
        write_atomic_json( join( hot, STATUS ), status )
    } catch ( error ) {
        log.warn( `Could not record the transcript ship: ${ error.message }` )
    }
    return status

}
