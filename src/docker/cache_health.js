import { readFileSync } from 'fs'
import { join } from 'path'
import { BABYSIT_DIR } from '../utils/paths.js'
import { run } from '../utils/exec.js'
import { write_atomic_json } from '../web_bridge/files.js'
import { docker_command_prefix } from './run.js'

// Docker's build cache can quietly grow to hundreds of GB; past that, the
// daemon's own cleanup holds locks for minutes and stalls every launch.
// Measuring it is itself lock-bound, so it runs rarely, in the background,
// and every reader (all `babysit watch` windows) shares one cached answer.
export const CACHE_HEALTH_PATH = join( BABYSIT_DIR, `docker-cache.json` )

const CHECK_INTERVAL_MS = 60 * 60_000

// Another watch window already measuring; a hung check is retried after this
const CHECK_CLAIM_MS = 10 * 60_000
const CHECK_TIMEOUT_MS = 2 * 60_000

// Twice the 50 GB GC cap, so a cache hovering at the cap never nags
export const BUILD_CACHE_WARN_BYTES = 100e9

const UNITS = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }

/**
 * Bytes from Docker's human sizes (`146.1GB`, `512MB`, `0B`).
 * @param {string} text - Size as Docker prints it
 * @returns {number|null} Bytes, or null when unreadable
 */
export const parse_docker_size = text => {
    const [ , amount, unit ] = String( text ).trim().match( /^([\d.]+)\s*([kKMGTP]?B)$/ ) || []
    return amount ? Math.round( Number( amount ) * UNITS[ unit ] ) : null
}

/**
 * Build cache total from `docker buildx du`, whose last line reads `Total: 146.1GB`.
 * @param {string} output - Command output
 * @returns {number|null} Bytes, or null when no total was printed
 */
export const parse_build_cache_total = output => {
    const [ , size ] = String( output ).match( /^Total:\s*(\S+)\s*$/m ) || []
    return size ? parse_docker_size( size ) : null
}

/**
 * The last measurement, whatever its age.
 * @param {string} [path=CACHE_HEALTH_PATH] - Cache path
 * @returns {Object} `{ checked_at?, claimed_at?, build_cache_bytes? }`
 */
export const read_cache_health = ( path = CACHE_HEALTH_PATH ) => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) ) || {}
    } catch {
        return {}
    }
}

/**
 * Measure the build cache when the last answer is over an hour old and no
 * other process is measuring right now. Never throws: a failed check leaves
 * the previous answer in place and is retried after the claim expires.
 * @param {Object} [options] - Seams
 * @returns {Promise<Object>} The health record after this call
 */
export const refresh_cache_health = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
    now = Date.now,
    path = CACHE_HEALTH_PATH,
} = {} ) => {

    const health = read_cache_health( path )
    const fresh = now() - ( health.checked_at ?? -Infinity ) < CHECK_INTERVAL_MS
    const claimed = now() - ( health.claimed_at ?? -Infinity ) < CHECK_CLAIM_MS
    if( fresh || claimed ) return health

    const save = record => {
        try {
            write_atomic_json( path, record )
        } catch {
            // Unwritable cache: the next frame simply measures again later
        }
        return record
    }

    save( { ...health, claimed_at: now() } )

    try {
        const [ command, ...prefix_args ] = command_prefix
        // The daemon's own builder: the cache `babysit prune` (docker builder prune) clears
        const output = await run_command( command, [ ...prefix_args, `buildx`, `du`, `--builder`, `default` ], {}, CHECK_TIMEOUT_MS )
        const build_cache_bytes = parse_build_cache_total( output )
        if( build_cache_bytes === null ) return health
        return save( { checked_at: now(), build_cache_bytes } )
    } catch {
        return health
    }

}

/**
 * The warning line for an oversized build cache, if any.
 * @param {Object} health - From read_cache_health
 * @returns {string|null}
 */
export const cache_warning = ( { build_cache_bytes } = {} ) => {
    if( !( build_cache_bytes > BUILD_CACHE_WARN_BYTES ) ) return null
    const size = `${ Math.round( build_cache_bytes / 1e9 ) } GB`
    return `Docker build cache is ${ size }: this slows down every launch. Run \`babysit prune\` to clear cache unused for 7 days.`
}
