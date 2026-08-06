import { spawnSync } from 'child_process'

import { log } from '../utils/log.js'
import { docker_command_prefix } from './run.js'

// These images are either established Watchtower releases or confirmed-safe
// forks/rebuilds. Most preserve the full-exclude label contract; whefter's
// deprecated fork is safe because it only watches explicitly tagged targets.
// Exact repository matching is deliberate: an unrelated image with a familiar
// name must not be trusted with an active, stateful Babysit session.
export const COMPATIBLE_WATCHTOWER_IMAGE_REPOSITORIES = Object.freeze( [
    `beatkind/watchtower`,
    `containrrr/watchtower`,
    `ghcr.io/beatkind/watchtower`,
    `ghcr.io/containrrr/watchtower`,
    `ghcr.io/dockhippie/watchtower`,
    `ghcr.io/jauderho/watchtower`,
    `ghcr.io/marrrrrrrrry/watchtower`,
    `ghcr.io/nicholas-fedor/watchtower`,
    `ghcr.io/openserbia/watchtower`,
    `ghcr.io/storj/watchtower`,
    `jauderho/watchtower`,
    `marrrrrrrrry/watchtower`,
    `nickfedor/watchtower`,
    `openserbia/watchtower`,
    `quay.io/webhippie/watchtower`,
    `storjlabs/watchtower`,
    `torusresearch/watchtower`,
    `webhippie/watchtower`,
    `whefter/watchtower`,
] )

const COMPATIBLE_WATCHTOWER_IMAGES = new Set( COMPATIBLE_WATCHTOWER_IMAGE_REPOSITORIES )
const DOCKER_HUB_REGISTRIES = /^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io|registry\.hub\.docker\.com)\//
const WATCHTOWER_NAME = /watchtower/i

/**
 * Strip a Docker image tag/digest and normalize Docker Hub registry aliases.
 * @param {string} image - Docker image reference
 * @returns {string} Lowercase repository reference without a tag or digest
 */
export const normalise_docker_image_repository = ( image = `` ) => {

    const [ reference ] = String( image ).trim().toLowerCase().split( `@`, 1 )
    const last_slash = reference.lastIndexOf( `/` )
    const last_colon = reference.lastIndexOf( `:` )
    const repository = last_colon > last_slash
        ? reference.slice( 0, last_colon )
        : reference

    return repository.replace( DOCKER_HUB_REGISTRIES, `` )

}

/**
 * Check whether an image is confirmed not to replace Babysit containers.
 * @param {string} image - Docker image reference
 * @returns {boolean} True for an exact compatible repository
 */
export const is_compatible_watchtower_image = ( image = `` ) =>
    COMPATIBLE_WATCHTOWER_IMAGES.has( normalise_docker_image_repository( image ) )

/**
 * Parse newline-delimited JSON emitted by `docker ps --format '{{json .}}'`.
 * @param {string} output - Docker ps stdout
 * @returns {{ containers: Array<{ name: string, image: string }>, invalid_rows: number }} Parsed containers and skipped rows
 */
export const parse_docker_ps_output = ( output = `` ) => {

    const rows = String( output )
        .split( `\n` )
        .map( row => row.trim() )
        .filter( Boolean )

    return rows.reduce( ( parsed, row ) => {

        try {
            const container = JSON.parse( row )
            parsed.containers.push( {
                name: String( container.Names || container.Name || `` ),
                image: String( container.Image || `` ),
            } )
        } catch {
            parsed.invalid_rows++
        }

        return parsed

    }, { containers: [], invalid_rows: 0 } )

}

/**
 * Select running containers that look like Watchtower but are not confirmed
 * safe for Babysit's stateful sessions.
 * @param {Array<{ name?: string, image?: string }>} containers - Running containers
 * @returns {Array<{ name: string, image: string }>} Unrecognized Watchtower-like containers
 */
export const find_unrecognized_watchtower_containers = ( containers = [] ) => containers
    .map( ( { name = ``, image = `` } ) => ( {
        name: String( name ),
        image: String( image ),
    } ) )
    .filter( ( { name, image } ) => WATCHTOWER_NAME.test( name ) || WATCHTOWER_NAME.test( image ) )
    .filter( ( { image } ) => !is_compatible_watchtower_image( image ) )

/**
 * Inspect running Docker containers for Watchtower-like names and images.
 * Detection is best-effort so a diagnostic failure never blocks Babysit.
 * @param {Object} [options]
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for process spawn
 * @param {Object} [options.env=process.env] - Environment controlling sudo use
 * @returns {{ containers: Array<{ name: string, image: string }>, invalid_rows: number, error: string|null }} Inspection result
 */
export const inspect_running_watchtower_containers = ( {
    spawn_sync = spawnSync,
    env = process.env,
} = {} ) => {

    const [ cmd, ...prefix_args ] = docker_command_prefix( { env } )
    let result

    try {
        result = spawn_sync( cmd, [
            ...prefix_args,
            `ps`,
            `--format`,
            `{{json .}}`,
        ], {
            encoding: `utf8`,
            stdio: [ `ignore`, `pipe`, `pipe` ],
            timeout: 3_000,
        } )
    } catch ( error ) {
        return { containers: [], invalid_rows: 0, error: error.message }
    }

    if( result.error ) return { containers: [], invalid_rows: 0, error: result.error.message }

    if( result.status !== 0 ) {
        const diagnostic = String( result.stderr || result.stdout || `` ).trim()
        return {
            containers: [],
            invalid_rows: 0,
            error: diagnostic || `${ cmd } ${ prefix_args.concat( `ps` ).join( ` ` ) } exited with code ${ result.status }`,
        }
    }

    const { containers, invalid_rows } = parse_docker_ps_output( result.stdout )

    return {
        containers: find_unrecognized_watchtower_containers( containers ),
        invalid_rows,
        error: null,
    }

}

/**
 * Log an unmistakable warning for running Watchtower-like containers whose
 * exclusion-label behavior has not been confirmed.
 * @param {Object} [options]
 * @param {Object} [options.logger=log] - Logger with warn/debug methods
 * @returns {Array<{ name: string, image: string }>} Containers that caused warnings
 */
export const warn_if_unrecognized_watchtower_is_running = ( {
    logger = log,
    ...inspection_options
} = {} ) => {

    const { containers, invalid_rows, error } = inspect_running_watchtower_containers( inspection_options )

    if( error ) {
        logger.debug( `Could not inspect running containers for Watchtower: ${ error }` )
        return []
    }

    if( invalid_rows ) logger.debug( `Skipped ${ invalid_rows } malformed Docker container row(s) while checking for Watchtower.` )
    if( !containers.length ) return []

    logger.warn( `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!` )
    logger.warn( `!!! UNRECOGNIZED WATCHTOWER CONTAINER DETECTED !!!` )
    logger.warn( `I see a Watchtower container that I don't recognize. This might kill Babysit by replacing its active container despite the safety label.` )
    containers.forEach( ( { name, image } ) => logger.warn( `Container: ${ name || `(unnamed)` } | Image: ${ image || `(unknown)` }` ) )
    logger.warn( `!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!` )

    return containers

}
