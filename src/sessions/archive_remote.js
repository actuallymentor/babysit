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
 *   <remote>/<hostname>/…       this host's hot archive (volumes/, sandbox/, sessions/)
 *
 * The identity can only be born on a mounted filesystem (never on the hot
 * archive's disk), and config remembers its id. An unmounted share is an empty
 * local directory: no identity, so nothing ships, and nothing lands on the
 * local disk by accident. Babysit never creates the remote root.
 */

export const SENTINEL = `.babysit-archive`
const STATUS = `.ship.json`
const LOCK = `.ship.lock`

// Shared by every monitor on the host: the status file throttles, the lock serialises
export const SHIP_INTERVAL_MS = 10 * 60_000
const SHIP_TIMEOUT_MS = 10 * 60_000

// Sandbox copies untouched this long (session gone) leave the hot archive once shipped
export const PRUNE_AFTER_MS = 7 * 24 * 60 * 60_000

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

    if( statSync( path ).dev === statSync( nearest_existing( hot ) ).dev ) {
        throw new Error( `${ path } is on the same disk as the local archive (${ hot }). Is the share mounted?` )
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

    const [ share, local ] = await Promise.all( [ stat( remote.path ), stat( hot ) ] )
    if( share.dev === local.dev ) return `on the local disk, not the share`

    return null

}

const with_timeout = ( promise, ms, label ) => {
    let timer
    const timeout = new Promise( ( _, reject ) => {
        timer = setTimeout( () => reject( new Error( `${ label } timed out` ) ), ms )
        timer.unref?.()
    } )
    return Promise.race( [ promise, timeout ] ).finally( () => clearTimeout( timer ) )
}

// Same size, mtime within 2 s (FAT-backed NAS shares round to 2 s)
const same_file = ( source, target ) => target && target.size === source.size && Math.abs( target.mtimeMs - source.mtimeMs ) < 2000

/**
 * Walk a tree's regular files: [ relative path, stats ]. Skips symlinks,
 * in-flight temp files and the ship bookkeeping at the root.
 * @param {string} root
 * @returns {AsyncGenerator<[ string, import('node:fs').Stats ]>}
 */
async function* files_in( root, relative = `` ) {
    const entries = await readdir( join( root, relative ), { withFileTypes: true } ).catch( () => [] )
    for( const entry of entries ) {
        const path = join( relative, entry.name )
        if( !relative && entry.name.startsWith( `.ship.` ) ) continue
        if( entry.isDirectory() ) yield* files_in( root, path )
        else if( entry.isFile() && !PARTIAL.test( entry.name ) ) yield [ path, await stat( join( root, path ) ) ]
    }
}

/**
 * Incremental copy, mtimes kept so an unchanged file costs one stat.
 * Temp name + rename: a cut connection never leaves a half file under a real name.
 * @param {string} source
 * @param {string} destination
 * @returns {Promise<number>} Files copied
 */
export const copy_tree = async ( source, destination ) => {

    let copied = 0
    for await ( const [ path, source_stats ] of files_in( source ) ) {
        const target = join( destination, path )
        if( same_file( source_stats, await stat( target ).catch( () => null ) ) ) continue

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

/**
 * Drop sandbox copies from the hot archive once their session is long gone
 * (index untouched for PRUNE_AFTER_MS) and every file is verified on the remote.
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
        for await ( const [ path, stats ] of files_in( join( hot, relative ) ) ) {
            if( same_file( stats, await stat( join( cold, relative, path ) ).catch( () => null ) ) ) continue
            verified = false
            break
        }
        if( !verified ) continue

        await rm( join( hot, relative ), { recursive: true, force: true } )
        pruned++

    }
    return pruned

}

/**
 * Last ship outcome: { checked_at, shipped_at, copied, pruned, error }.
 * @param {string} hot
 * @returns {Object|null}
 */
export const read_ship_status = hot => hot ? read_json( join( hot, STATUS ) ) : null

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

    const previous = read_ship_status( hot )
    if( previous && now - previous.checked_at < SHIP_INTERVAL_MS ) return null

    const release = take_lock( hot )
    if( !release ) return null

    let status
    try {

        const problem = await with_timeout( remote_problem( remote, hot ), timeout_ms, `Remote check` )
        if( problem ) throw new Error( problem )

        const cold = join( remote.path, host )
        const copied = await with_timeout( copy_tree( hot, cold ), timeout_ms, `Shipping` )
        const pruned = await with_timeout( prune_shipped( hot, cold, now ), timeout_ms, `Pruning` )
        status = { checked_at: now, shipped_at: now, copied, pruned, error: null }

    } catch ( error ) {
        log.warn( `Remote transcript archive ${ remote.path }: ${ error.message }` )
        status = { ...previous, checked_at: now, error: error.message }
    } finally {
        if( status ) write_atomic_json( join( hot, STATUS ), status )
        release()
    }
    return status

}
