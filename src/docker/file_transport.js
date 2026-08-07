import { chmodSync, statSync } from 'fs'

import { run } from '../utils/exec.js'
import { docker_command_prefix } from './run.js'

const DOCKER_COPY_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000

/**
 * Restore a pulled credential file to a mode the container's remapped node
 * user can read and rewrite on the next push. `sudo docker cp` can leave the
 * local destination owned by root, while an agent-side atomic rewrite can
 * reduce its mode to 0600. The private 0700 parent remains the secrecy boundary.
 *
 * @param {string} local_path - Client-local credential sync path
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @param {string[]} [options.command_prefix=docker_command_prefix()] - Active Docker prefix
 * @param {Function} [options.stat_sync=statSync] - Injectable stat helper
 * @param {Function} [options.chmod_sync=chmodSync] - Injectable chmod helper
 * @param {number|null} [options.uid=process.getuid()] - Invoking uid
 * @param {number|null} [options.gid=process.getgid()] - Invoking gid
 * @returns {Promise<void>}
 */
export const normalise_local_sync_file = async ( local_path, {
    run_command = run,
    command_prefix = docker_command_prefix(),
    stat_sync = statSync,
    chmod_sync = chmodSync,
    uid = process.getuid?.() ?? null,
    gid = process.getgid?.() ?? null,
} = {} ) => {

    const mode = stat_sync( local_path ).mode & 0o777
    if( ( mode & 0o006 ) === 0o006 ) return

    try {
        chmod_sync( local_path, 0o666 )
        return
    } catch ( error ) {
        const uses_sudo = command_prefix[0] === `sudo`
        if( !uses_sudo || uid === null || gid === null ) throw error
    }

    await run_command(
        `sudo`,
        [ `chown`, `${ uid }:${ gid }`, local_path ],
        {},
        DOCKER_CLEANUP_TIMEOUT_MS
    )
    chmod_sync( local_path, 0o666 )

}

/**
 * Build a bidirectional file transport through Docker's client API. Unlike a
 * bind mount, `docker cp` reads and writes paths from the client, so nested and
 * remote daemons do not need to see the client's temporary directory.
 *
 * @param {string} container_id - Prepared/running Docker container id
 * @param {string} container_path - Credential path inside the container
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {{ pull: Function, push: Function }} Credential file transport
 */
export const create_docker_file_transport = ( container_id, container_path, {
    run_command = run,
    normalise_local_file = path => normalise_local_sync_file( path, { run_command } ),
} = {} ) => {

    const [ command, ...prefix_args ] = docker_command_prefix()

    return {
        pull: async local_path => {
            await run_command(
                command,
                [ ...prefix_args, `cp`, `${ container_id }:${ container_path }`, local_path ],
                {},
                DOCKER_COPY_TIMEOUT_MS
            )
            await normalise_local_file( local_path )
        },
        push: local_path => run_command(
            command,
            [ ...prefix_args, `cp`, local_path, `${ container_id }:${ container_path }` ],
            {},
            DOCKER_COPY_TIMEOUT_MS
        ),
    }

}

/**
 * Remove a staged container after its final credential pull completes.
 * Staged launches intentionally omit `--rm` so rotated credentials remain
 * available in the stopped container until the detached monitor flushes them.
 *
 * @param {string} container_id - Docker container to remove
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @returns {Promise<void>}
 */
export const remove_docker_container = async ( container_id, {
    run_command = run,
} = {} ) => {

    if( !container_id ) return

    const [ command, ...prefix_args ] = docker_command_prefix()
    await run_command(
        command,
        [ ...prefix_args, `rm`, `-f`, container_id ],
        {},
        DOCKER_CLEANUP_TIMEOUT_MS
    )

}
