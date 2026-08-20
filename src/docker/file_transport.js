import { chmodSync, statSync } from 'fs'

import { run } from '../utils/exec.js'
import { docker_command_prefix } from './run.js'

const DOCKER_COPY_TIMEOUT_MS = 60_000
const DOCKER_CLEANUP_TIMEOUT_MS = 30_000
const DOCKER_INSPECT_TIMEOUT_MS = 5_000
const DOCKER_STOP_WAIT_TIMEOUT_MS = 45_000
const DOCKER_STOP_POLL_INTERVAL_MS = 100
const STOPPED_CONTAINER_STATES = new Set( [ `created`, `dead`, `exited` ] )

const wait = ms => new Promise( resolve_wait => setTimeout( resolve_wait, ms ) )

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

    const stats = stat_sync( local_path )
    const mode = stats.mode & 0o777
    const uses_sudo = command_prefix[0] === `sudo`
    const owned_by_invoker = uid !== null
        && gid !== null
        && stats.uid === uid
        && stats.gid === gid

    // A non-sudo Docker client creates local copies as the invoking user, so
    // world-write is sufficient there. With `sudo docker cp`, a mode-0666 file
    // can still be root-owned; rewrite_tmpfile's later chmod would then fail.
    if( ( mode & 0o006 ) === 0o006 && ( !uses_sudo || owned_by_invoker ) ) return

    try {
        chmod_sync( local_path, 0o666 )
        return
    } catch ( error ) {
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
 * Wait until Docker exposes a container filesystem as stopped and copy-safe.
 * Moby can report the process exit timestamp seconds before its daemon finishes
 * stream, logger, and task cleanup, so final credential pulls wait for the
 * stable stopped state rather than racing that bookkeeping.
 *
 * @param {string|null} container_id - Prepared/running Docker container id
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Injectable command runner
 * @param {Function} [options.wait_fn] - Injectable delay helper
 * @param {Function} [options.now=Date.now] - Injectable clock
 * @param {number} [options.timeout_ms=45000] - Total stopped-state wait
 * @param {number} [options.poll_interval_ms=100] - Delay between inspections
 * @returns {Promise<string|null>} Stable Docker state, or null without a container
 */
export const wait_for_docker_container_stopped = async ( container_id, {
    run_command = run,
    wait_fn = wait,
    now = Date.now,
    timeout_ms = DOCKER_STOP_WAIT_TIMEOUT_MS,
    poll_interval_ms = DOCKER_STOP_POLL_INTERVAL_MS,
} = {} ) => {

    if( !container_id ) return null

    const [ command, ...prefix_args ] = docker_command_prefix()
    const deadline = now() + timeout_ms
    let last_status = `unknown`
    let last_error = null

    while( true ) {
        try {
            last_status = await run_command(
                command,
                [ ...prefix_args, `inspect`, `--format`, `{{.State.Status}}`, container_id ],
                {},
                DOCKER_INSPECT_TIMEOUT_MS
            )
            last_error = null
            if( STOPPED_CONTAINER_STATES.has( last_status ) ) return last_status
        } catch ( error ) {
            last_error = error
        }

        const remaining_ms = deadline - now()
        if( remaining_ms <= 0 ) break

        await wait_fn( Math.min( poll_interval_ms, remaining_ms ) )
    }

    const diagnostic = last_error?.message || `last state: ${ last_status }`
    throw new Error( `Docker container ${ container_id } did not stop within ${ timeout_ms }ms (${ diagnostic })` )

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
