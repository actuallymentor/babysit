import { request } from 'http'

import { run } from '../utils/exec.js'
import { docker_command_prefix } from './run.js'

// Must match the `until=` filter `babysit prune` passes to `docker builder prune`
export const BUILD_CACHE_KEEP_MS = 7 * 24 * 60 * 60_000

const UNITS = { B: 1, kB: 1e3, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 }

const AGE_UNITS = {
    second: 1_000,
    minute: 60_000,
    hour: 60 * 60_000,
    day: 24 * 60 * 60_000,
    week: 7 * 24 * 60 * 60_000,
    month: 30 * 24 * 60 * 60_000,
    year: 365 * 24 * 60 * 60_000,
}

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
 * Milliseconds from Docker's human ages (`5 days ago`, `About an hour ago`).
 * @param {string} text - Age as Docker prints it
 * @returns {number|null}
 */
export const parse_docker_age = text => {
    const [ , count, unit ] = String( text ).trim().toLowerCase()
        .match( /^(?:about\s+)?(\d+|an?|less than a)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/ ) || []
    if( !unit ) return null
    return ( /^\d+$/.test( count ) ? Number( count ) : 1 ) * AGE_UNITS[ unit ]
}

/**
 * Sizes from `docker buildx du`. Its `--filter until=` is silently ignored
 * (and drops the Total line), so prunable cache is summed from each row's
 * last access. Shared rows (`12GB*`) overlap, so that sum is an estimate.
 * @param {string} output - Default `docker buildx du` table
 * @param {number} [keep_ms] - Cache used more recently than this is kept
 * @returns {{ total_bytes: number|null, prunable_bytes: number, private_prunable_bytes: number }}
 */
export const parse_build_cache = ( output, keep_ms = BUILD_CACHE_KEEP_MS ) => {

    const text = String( output )
    const [ , total ] = text.match( /^Total:\s*(\S+)\s*$/m ) || []
    let prunable_bytes = 0
    // Shared rows (`12GB*`) back layers other records or images still use:
    // pruning them may only drop metadata, so they never count toward the minimum
    let private_prunable_bytes = 0

    for( const line of text.split( `\n` ) ) {
        const [ , reclaimable, size, shared, age ] = line.match( /^\S+\s+(true|false)\s+(\S+?)(\*?)\s+(.+)$/ ) || []
        if( reclaimable !== `true` ) continue

        // Never-used rows have no age; buildkit then falls back to creation
        // time, which is at least as old as last use would be
        const age_ms = parse_docker_age( age )
        if( age_ms !== null && age_ms < keep_ms ) continue

        const bytes = parse_docker_size( size ) ?? 0
        prunable_bytes += bytes
        if( !shared ) private_prunable_bytes += bytes
    }

    return { total_bytes: total ? parse_docker_size( total ) : null, prunable_bytes, private_prunable_bytes }

}

/**
 * Measure the daemon's own build cache, the one `babysit prune` clears.
 * @param {Object} [options] - Seams
 * @returns {Promise<{ total_bytes: number|null, prunable_bytes: number, private_prunable_bytes: number }>}
 */
export const measure_build_cache = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
    timeout_ms = 2 * 60_000,
} = {} ) => {
    const [ command, ...prefix_args ] = command_prefix
    return parse_build_cache( await run_command( command, [ ...prefix_args, `buildx`, `du`, `--builder`, `default` ], {}, timeout_ms ) )
}

/**
 * Where the daemon keeps its data. `docker info` can wait minutes on daemon
 * locks, so callers cache the answer: it only changes with daemon config.
 * @param {Object} [options] - Seams
 * @returns {Promise<string|null>} Absolute path as the daemon sees it
 */
export const docker_root_dir = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
    timeout_ms = 2 * 60_000,
} = {} ) => {
    const [ command, ...prefix_args ] = command_prefix
    const output = await run_command( command, [ ...prefix_args, `info`, `--format`, `{{.DockerRootDir}}` ], {}, timeout_ms )
    return output.startsWith( `/` ) ? output : null
}

/**
 * The daemon's local socket, when this process can talk to it directly.
 * A sudo prefix means the socket is not ours to open; remote hosts are skipped.
 * @param {Object} [options]
 * @returns {string|null}
 */
export const docker_socket_path = ( { env = process.env, command_prefix = docker_command_prefix( { env } ) } = {} ) => {
    if( command_prefix.length > 1 ) return null
    const host = env.DOCKER_HOST || `unix:///var/run/docker.sock`
    return host.startsWith( `unix://` ) ? host.slice( `unix://`.length ) : null
}

/**
 * Per-image bytes shared with other images, which the CLI cannot report
 * without `docker system df` (minutes on a busy daemon: it also sizes every
 * container). The Engine API answers the image part alone in well under a second.
 * @param {Object} [options]
 * @param {string|null} [options.socket_path] - Unix socket; null skips the query
 * @param {number} [options.timeout_ms]
 * @returns {Promise<Map<string, number>|null>} Image id → shared bytes, or null when unavailable
 */
export const image_shared_sizes = ( { socket_path = docker_socket_path(), timeout_ms = 30_000 } = {} ) => {

    if( !socket_path ) return Promise.resolve( null )

    return new Promise( resolve => {

        const req = request( { socketPath: socket_path, path: `/images/json?all=1&shared-size=1`, timeout: timeout_ms }, response => {
            let body = ``
            response.on( `data`, chunk => body += chunk )
            response.on( `end`, () => {
                try {
                    const images = JSON.parse( body )
                    if( response.statusCode !== 200 || !Array.isArray( images ) ) return resolve( null )
                    // -1 means the daemon did not compute it
                    resolve( new Map( images.filter( ( { SharedSize } ) => SharedSize >= 0 ).map( ( { Id, SharedSize } ) => [ Id, SharedSize ] ) ) )
                } catch {
                    resolve( null )
                }
            } )
        } )

        req.on( `timeout`, () => req.destroy() )
        req.on( `error`, () => resolve( null ) )
        req.end()

    } )

}
