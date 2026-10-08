import { inspect_stored_sessions } from '../sessions/store.js'
import { run } from '../utils/exec.js'
import { SESSIONS_DIR } from '../utils/paths.js'
import { basename, dirname } from 'path'
import { docker_command_prefix, resolve_workspace_mount_source } from './run.js'
import { get_image_name } from './update.js'

const lines = value => value.split( `\n` ).filter( Boolean )

/**
 * Reclaim Docker resources without deleting containers or images saved sessions need.
 * Docker refuses to remove images still referenced by unrelated containers.
 * @param {Object} [options]
 * @param {string} [options.sessions_dir] - Saved session registry
 * @param {Function} [options.run_command] - Docker command runner
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @returns {Promise<string>} Cleanup summary
 */
export const prune_unused_docker = async ( {
    sessions_dir = SESSIONS_DIR,
    run_command = run,
    command_prefix = docker_command_prefix(),
} = {} ) => {

    const stored = inspect_stored_sessions( { directory: sessions_dir } )
    if( stored.invalid_files.length ) throw new Error( `Session registry unreadable; Docker cleanup skipped.` )

    const sessions = stored.records.map( ( { session } ) => session )
    const saved_containers = new Set( sessions.flatMap( session => [ session.container_id, session.container_name ] ).filter( Boolean ) )
    const saved_images = new Set( sessions.filter( session => !session.clone_pruned_at )
        .map( session => session.image_id ).filter( Boolean ) )
    const [ command, ...prefix_args ] = command_prefix
    const docker = ( args, timeout_ms = 30_000 ) => run_command( command, [ ...prefix_args, ...args ], {}, timeout_ms )

    // Enumerate before deleting anything; a failed Docker inspection must not
    // turn missing state into permission to remove a recovery resource.
    const containers = lines( await docker( [
        `container`, `ls`, `--all`,
        `--filter`, `status=created`, `--filter`, `status=exited`, `--filter`, `status=dead`,
        `--no-trunc`, `--format`, `{{.ID}}\t{{.Names}}`,
    ] ) )
        .map( row => row.split( `\t` ) )
    const images = new Set( lines( await docker( [ `image`, `ls`, `--all`, `--no-trunc`, `--quiet` ] ) ) )
    if( containers.some( ( [ id, name ] ) => !id || !name ) ) {
        throw new Error( `Docker container listing unreadable; cleanup skipped.` )
    }
    let removed_containers = 0
    let removed_images = 0

    for( const [ id, name ] of containers ) {
        // Other accounts can share this daemon. Their Babysit records are not
        // readable here, so keep every Babysit-named container.
        if( name.startsWith( `babysit-` ) || saved_containers.has( id ) || saved_containers.has( name ) ) continue

        try {
            await docker( [ `container`, `rm`, id ], 2 * 60_000 )
            removed_containers++
        } catch {
            // Another process may have restarted or removed this container.
        }
    }

    for( const image of images ) {
        if( saved_images.has( image ) ) continue

        try {
            await docker( [ `image`, `rm`, image ], 2 * 60_000 )
            removed_images++
        } catch {
            // Docker keeps images used by containers or multiple tags.
        }
    }

    await docker( [ `network`, `prune`, `--force` ] )
    await docker( [ `builder`, `prune`, `--force` ], 10 * 60_000 )

    return `Docker: removed ${ removed_containers } stopped containers and ${ removed_images } images; pruned unused networks and build cache. Volumes kept.`

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
