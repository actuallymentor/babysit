import { readFileSync } from 'fs'
import { join } from 'path'

import { directory_bytes, format_bytes, group_by_filesystem, tilde } from './disk.js'
import { docker_root_dir, measure_build_cache } from './docker/disk_usage.js'
import { BABYSIT_DIR, CLONES_DIR } from './utils/paths.js'
import { write_atomic_json } from './web_bridge/files.js'

// What Babysit stores (clones, Docker build cache) is slow to measure: `du`
// walks millions of files and `buildx du` waits on daemon locks. So it runs
// hourly in the background and every `babysit watch` window shares one answer.
// Free space is cheap (statfs) and read live on every frame.
export const DISK_HEALTH_PATH = join( BABYSIT_DIR, `disk-health.json` )

const CHECK_INTERVAL_MS = 60 * 60_000

// Another watch window already measuring; a hung check is retried after this
const CHECK_CLAIM_MS = 15 * 60_000

// Warn when the disk runs low AND Babysit holds a real share of it, so a
// big drive with a big-but-proportionate cache never nags
export const LOW_FREE_RATIO = 0.15
export const HEAVY_SHARE_RATIO = 0.20

// Once warned, stay warned until this much is free again: no flicker at the line
export const CLEAR_FREE_RATIO = 0.20

// A nearly full disk breaks clone locks and launches, whoever filled it.
// Still needs the low ratio, so a small VM disk with 9 GB free stays quiet.
export const CRITICAL_FREE_BYTES = 10e9

// Huge build caches stall launches while the daemon cleans them up; that
// cost is absolute, not relative to the drive. Four times the 50 GB GC cap.
export const BUILD_CACHE_WARN_BYTES = 200e9

/**
 * The last measurement, whatever its age.
 * @param {string} [path=DISK_HEALTH_PATH]
 * @returns {Object} `{ checked_at?, claimed_at?, clones_dir?, clones_bytes?, docker_root_dir?, build_cache_bytes? }`
 */
export const read_disk_health = ( path = DISK_HEALTH_PATH ) => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) ) || {}
    } catch {
        return {}
    }
}

/**
 * Measure Babysit's storage when the last answer is over an hour old and no
 * other process is measuring right now. Never throws: each measurement that
 * fails keeps its previous value, and the next one is due after the claim.
 * @param {Object} [options] - Seams
 * @returns {Promise<Object>} The health record after this call
 */
export const refresh_disk_health = async ( {
    measure_cache = measure_build_cache,
    find_root_dir = docker_root_dir,
    measure_directory = directory_bytes,
    clones_dir = CLONES_DIR,
    now = Date.now,
    path = DISK_HEALTH_PATH,
} = {} ) => {

    const health = read_disk_health( path )
    const fresh = now() - ( health.checked_at ?? -Infinity ) < CHECK_INTERVAL_MS
    const claimed = now() - ( health.claimed_at ?? -Infinity ) < CHECK_CLAIM_MS
    if( fresh || claimed ) return health

    const save = record => {
        try {
            write_atomic_json( path, record )
        } catch {
            // Unwritable: the next frame simply measures again later
        }
        return record
    }

    save( { ...health, claimed_at: now() } )

    const settle = promise => promise.then( value => value ?? null, () => null )
    const [ cache, root_dir, clones_bytes ] = await Promise.all( [
        settle( measure_cache() ),
        // Only changes with daemon config, and `docker info` is slow
        health.docker_root_dir ? health.docker_root_dir : settle( find_root_dir() ),
        settle( measure_directory( clones_dir ) ),
    ] )

    return save( {
        checked_at: now(),
        clones_dir,
        clones_bytes: clones_bytes ?? health.clones_bytes ?? null,
        docker_root_dir: root_dir ?? health.docker_root_dir ?? null,
        build_cache_bytes: cache?.total_bytes ?? health.build_cache_bytes ?? null,
    } )

}

/**
 * Whether one filesystem is under pressure, with hysteresis.
 * @param {{ total_bytes: number, free_bytes: number, babysit_bytes: number }} filesystem
 * @param {boolean} [was_pressured] - Warned on the previous check
 * @returns {boolean}
 */
export const under_pressure = ( { total_bytes, free_bytes, babysit_bytes }, was_pressured = false ) => {

    if( !( total_bytes > 0 ) ) return false
    const free_ratio = free_bytes / total_bytes
    const low = free_ratio < ( was_pressured ? CLEAR_FREE_RATIO : LOW_FREE_RATIO )
    if( !low ) return false

    return free_bytes < CRITICAL_FREE_BYTES || babysit_bytes / total_bytes > HEAVY_SHARE_RATIO

}

/**
 * Storage warnings for `babysit watch`, using live free space.
 * @param {Object} health - From read_disk_health
 * @param {Object} [options]
 * @param {Set<number>} [options.pressured] - Filesystems warned about last time
 * @param {Object} [options.seams] - statfs/stat seams for group_by_filesystem
 * @returns {{ lines: string[], pressured: Set<number> }}
 */
export const disk_warnings = ( health = {}, { pressured = new Set(), seams } = {} ) => {

    const lines = []
    const now_pressured = new Set()
    const parts = [
        { path: health.clones_dir, label: `clones`, bytes: health.clones_bytes },
        { path: health.docker_root_dir, label: `Docker build cache`, bytes: health.build_cache_bytes },
    ].filter( ( { bytes } ) => Number.isFinite( bytes ) )

    for( const filesystem of group_by_filesystem( parts, seams ) ) {
        const babysit_bytes = filesystem.parts.reduce( ( sum, { bytes } ) => sum + bytes, 0 )
        if( !under_pressure( { ...filesystem, babysit_bytes }, pressured.has( filesystem.dev ) ) ) continue

        now_pressured.add( filesystem.dev )
        const used_percent = Math.round( 100 * ( 1 - filesystem.free_bytes / filesystem.total_bytes ) )
        const breakdown = filesystem.parts.map( ( { label, bytes } ) => `${ label } ${ format_bytes( bytes ) }` ).join( `, ` )
        lines.push( `Disk holding ${ tilde( filesystem.path ) } is ${ used_percent }% full (${ format_bytes( filesystem.free_bytes ) } free); Babysit stores ${ breakdown }. Run \`babysit prune\` to see what can go.` )
    }

    if( health.build_cache_bytes > BUILD_CACHE_WARN_BYTES ) {
        lines.push( `Docker build cache is ${ format_bytes( health.build_cache_bytes ) }: this slows down every launch. Run \`babysit prune\` to clear cache unused for 7 days.` )
    }

    return { lines, pressured: now_pressured }

}
