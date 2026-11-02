import { inspect_stored_sessions } from '../sessions/store.js'
import { run } from '../utils/exec.js'
import { SESSIONS_DIR } from '../utils/paths.js'
import { basename, dirname } from 'path'
import { docker_command_prefix, resolve_workspace_mount_source } from './run.js'
import { get_image_name } from './update.js'
import { image_shared_sizes, measure_build_cache, parse_docker_size } from './disk_usage.js'

const lines = value => value.split( `\n` ).filter( Boolean )

const docker_runner = ( run_command, command_prefix ) => {
    const [ command, ...prefix_args ] = command_prefix
    return ( args, timeout_ms = 30_000 ) => run_command( command, [ ...prefix_args, ...args ], {}, timeout_ms )
}

// Images still used by a container that stays. Docker refuses to remove them
// anyway; leaving them out keeps the size estimate honest. Best effort: an
// unreadable answer keeps every candidate, and Docker still says no.
const images_in_use = async ( docker, removed_ids ) => {

    try {
        const remaining = lines( await docker( [ `container`, `ls`, `--all`, `--no-trunc`, `--quiet` ] ) )
            .filter( id => !removed_ids.has( id ) )
        if( !remaining.length ) return new Set()
        return new Set( lines( await docker( [ `container`, `inspect`, `--format`, `{{.Image}}`, ...remaining ] ) ) )
    } catch {
        return new Set()
    }

}

// Containers and images saved sessions still need for resume and recovery
const saved_resources = sessions_dir => {

    const stored = inspect_stored_sessions( { directory: sessions_dir } )
    if( stored.invalid_files.length ) throw new Error( `Session registry unreadable; Docker cleanup skipped.` )

    const sessions = stored.records.map( ( { session } ) => session )
    return {
        containers: new Set( sessions.flatMap( session => [ session.container_id, session.container_name ] ).filter( Boolean ) ),
        images: new Set( sessions.filter( session => !session.clone_pruned_at ).map( session => session.image_id ).filter( Boolean ) ),
    }

}

/**
 * Decide what Docker cleanup would remove, and roughly how much it frees,
 * without deleting anything. Saved sessions keep their containers and images.
 * @param {Object} [options]
 * @param {string} [options.sessions_dir] - Saved session registry
 * @param {Function} [options.run_command] - Docker command runner
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @param {Function} [options.measure_cache] - Build cache measurement
 * @param {Function} [options.shared_sizes] - Per-image shared bytes, or null when unavailable
 * @returns {Promise<Object>} `{ containers, images, image_bytes, image_unique_bytes, build_cache_bytes, build_cache_private_bytes, build_cache_total_bytes }`
 */
export const plan_docker_prune = async ( {
    sessions_dir = SESSIONS_DIR,
    run_command = run,
    command_prefix = docker_command_prefix(),
    measure_cache = options => measure_build_cache( options ),
    shared_sizes = () => image_shared_sizes( { command_prefix } ),
} = {} ) => {

    const { containers: saved_containers, images: saved_images } = saved_resources( sessions_dir )
    const docker = docker_runner( run_command, command_prefix )

    // Enumerate before deleting anything; a failed Docker inspection must not
    // turn missing state into permission to remove a recovery resource.
    const stopped = lines( await docker( [
        `container`, `ls`, `--all`,
        `--filter`, `status=created`, `--filter`, `status=exited`, `--filter`, `status=dead`,
        `--no-trunc`, `--format`, `{{.ID}}\t{{.Names}}`,
    ] ) )
        .map( row => row.split( `\t` ) )
    const image_rows = lines( await docker( [ `image`, `ls`, `--all`, `--no-trunc`, `--format`, `{{.ID}}\t{{.Size}}` ] ) )
        .map( row => row.split( `\t` ) )
    if( stopped.some( ( [ id, name ] ) => !id || !name ) ) {
        throw new Error( `Docker container listing unreadable; cleanup skipped.` )
    }

    // Other accounts can share this daemon. Their Babysit records are not
    // readable here, so keep every Babysit-named container.
    const containers = stopped
        .filter( ( [ id, name ] ) => !name.startsWith( `babysit-` ) && !saved_containers.has( id ) && !saved_containers.has( name ) )
        .map( ( [ id, name ] ) => ( { id, name } ) )

    // One row per tag. `image rm <id>` refuses an image with several tags,
    // so those are neither planned nor counted
    const tags = new Map()
    image_rows.forEach( ( [ id, size ] ) => tags.set( id, { bytes: parse_docker_size( size ) ?? 0, count: ( tags.get( id )?.count ?? 0 ) + 1 } ) )
    const in_use = await images_in_use( docker, new Set( containers.map( ( { id } ) => id ) ) )
    const images = [ ...tags ]
        .filter( ( [ id, { count } ] ) => count === 1 && !saved_images.has( id ) && !in_use.has( id ) )
        .map( ( [ id, { bytes } ] ) => [ id, bytes ] )
        .map( ( [ id, bytes ] ) => ( { id, bytes } ) )

    // Unmeasurable sizes only cost the estimate, never the cleanup
    const [ cache, shared ] = await Promise.all( [
        measure_cache( { run_command, command_prefix } ).catch( () => null ),
        shared_sizes().catch( () => null ),
    ] )

    // Images share layers, so their sizes add up to an upper bound. Bytes no
    // other image uses are certain to go: their sum is the lower bound.
    const unique_bytes = shared && images.every( ( { id } ) => shared.has( id ) )
        ? images.reduce( ( sum, { id, bytes } ) => sum + Math.max( 0, bytes - shared.get( id ) ), 0 )
        : null

    return {
        containers,
        images,
        image_bytes: images.reduce( ( sum, { bytes } ) => sum + bytes, 0 ),
        image_unique_bytes: unique_bytes,
        build_cache_bytes: cache?.prunable_bytes ?? null,
        build_cache_private_bytes: cache?.private_prunable_bytes ?? null,
        build_cache_total_bytes: cache?.total_bytes ?? null,
    }

}

/**
 * Reclaim Docker resources without deleting containers or images saved sessions need.
 * Docker refuses to remove images still referenced by unrelated containers.
 * @param {Object} [options]
 * @param {Object} [options.plan] - From plan_docker_prune; planned here when absent
 * @param {string} [options.sessions_dir] - Saved session registry
 * @param {Function} [options.run_command] - Docker command runner
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @returns {Promise<string>} Cleanup summary
 */
export const prune_unused_docker = async ( {
    sessions_dir = SESSIONS_DIR,
    run_command = run,
    command_prefix = docker_command_prefix(),
    plan = null,
} = {} ) => {

    const planned = plan || await plan_docker_prune( { sessions_dir, run_command, command_prefix } )

    // A plan can wait minutes for confirmation while sessions start and end.
    // Re-read the registry now, so anything saved meanwhile is kept.
    const saved = saved_resources( sessions_dir )
    const containers = planned.containers.filter( ( { id, name } ) => !saved.containers.has( id ) && !saved.containers.has( name ) )
    const images = planned.images.filter( ( { id } ) => !saved.images.has( id ) )
    const docker = docker_runner( run_command, command_prefix )
    let removed_containers = 0
    let removed_images = 0

    for( const { id } of containers ) {
        try {
            await docker( [ `container`, `rm`, id ], 2 * 60_000 )
            removed_containers++
        } catch {
            // Another process may have restarted or removed this container.
        }
    }

    for( const { id } of images ) {
        try {
            await docker( [ `image`, `rm`, id ], 2 * 60_000 )
            removed_images++
        } catch {
            // Docker keeps images used by containers or multiple tags.
        }
    }

    await docker( [ `network`, `prune`, `--force` ] )
    // Without --all only dangling cache goes, and old-but-referenced cache grew
    // to 425 GB on one host. Seven days keeps recent builds warm; deleting
    // hundreds of GB on ZFS took 30 min, so the deadline is generous.
    await docker( [ `builder`, `prune`, `--force`, `--all`, `--filter`, `until=168h` ], 60 * 60_000 )

    return `Docker: removed ${ removed_containers } stopped containers and ${ removed_images } images; pruned unused networks and build cache older than 7 days. Volumes kept.`

}

/**
 * Delete a quarantined clone tree that contains files the host user does not
 * own (written as root inside a container). A throwaway container running as
 * root on the babysit image removes it; only the quarantine's parent is mounted.
 * @param {string} path - Absolute quarantine path
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Docker command runner
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @param {string} [options.image] - Image to run `rm` from
 * @returns {Promise<void>}
 */
export const remove_tree_as_root = async ( path, {
    run_command = run,
    command_prefix = docker_command_prefix(),
    image = get_image_name(),
} = {} ) => {

    const [ command, ...prefix_args ] = command_prefix

    // Bind mounts are resolved by the daemon host, so a nested Babysit session
    // must hand over the host-visible path.
    await run_command( command, [
        ...prefix_args, `run`, `--rm`, `--user`, `0`, `--network`, `none`,
        `-v`, `${ resolve_workspace_mount_source( dirname( path ) ) }:/babysit-trash`,
        `--entrypoint`, `rm`, image, `-rf`, `/babysit-trash/${ basename( path ) }`,
    ], {}, 120_000 )

}
