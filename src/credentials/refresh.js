import { readFileSync } from 'fs'
import { createHash } from 'crypto'

import { log } from '../utils/log.js'
import { rewrite_tmpfile } from '../utils/tmpfile.js'

/**
 * Hash credential content without persisting the secret itself.
 * @param {string} content - Credential file content
 * @returns {string} SHA-256 hash
 */
export const hash_credential_content = ( content ) => createHash( `sha256` ).update( content ).digest( `hex` )

/**
 * Build the hash baseline for a host credential file and its staged sync copy.
 * The values are safe to store in session metadata because they contain no
 * credential material.
 *
 * @param {string} source_path - Host credential path
 * @param {string} tmpfile_path - Mounted tmpfile path
 * @returns {{ baseline_source_hash: string, baseline_tmpfile_hash: string }|null}
 */
export const build_credential_sync_baseline = ( source_path, tmpfile_path ) => {

    try {

        const source = readFileSync( source_path, `utf-8` )
        const tmpfile = readFileSync( tmpfile_path, `utf-8` )

        return {
            baseline_source_hash: hash_credential_content( source ),
            baseline_tmpfile_hash: hash_credential_content( tmpfile ),
        }

    } catch {
        return null
    }

}

// Refresh interval for credential sync daemon (5 minutes)
const REFRESH_INTERVAL_MS = 300_000

/**
 * Start a bidirectional credential sync loop. Periodically:
 *   1. If the host source changed, write its new content into the local sync
 *      copy and push it into the container through the connected transport.
 *   2. Otherwise pull container state into the local sync copy. If that copy
 *      changed, call `write_destination` so the host source catches up.
 *
 * Direction (2) is what prevents the "refresh token already used" error on the
 * NEXT babysit session: without it, each session ends with fresh tokens in the
 * container but stale (and now server-invalidated) tokens on the host. The next
 * session would then copy the invalidated tokens forward and fail on first
 * refresh attempt. Skip direction (2) by passing `write_destination = null` —
 * appropriate for keychain-backed creds where the agent's own pre-flight rotation
 * is reliable (claude on darwin) and round-tripping to the keychain has a
 * different shape than a file write.
 *
 * Writes to the local sync copy stay in-place so the foreground and detached
 * monitor always observe the same path from session metadata.
 *
 * @param {Function} read_source - Async function that returns current host credential string
 * @param {string} tmpfile_path - Client-local credential sync path
 * @param {Function|null} [write_destination=null] - Async function that receives the tmpfile's
 *   updated content and writes it back to the host source. Pass null to keep sync one-way.
 * @param {Object} [options]
 * @param {string|null} [options.baseline_source_hash] - Hash of the host source when the tmpfile
 *   was captured by the foreground process
 * @param {string|null} [options.baseline_tmpfile_hash] - Hash of the sync copy when captured
 * @returns {{ set_transport: Function, stop: Function }} Sync controller
 */
export const start_credential_sync = ( read_source, tmpfile_path, write_destination = null, options = {} ) => {

    const { baseline_source_hash = null, baseline_tmpfile_hash = null } = options

    let last_source_hash = baseline_source_hash
    let last_tmpfile_hash = baseline_tmpfile_hash || baseline_source_hash
    let transport = null
    let tick_queue = Promise.resolve()

    // Seed both hashes from the initial tmpfile write — at start of session,
    // tmpfile content === source content, so they share a hash. The detached
    // monitor passes explicit foreground-capture hashes because codex can
    // refresh the staged credential before the monitor starts; in that case,
    // seeding from the current tmpfile would make the stale host file look
    // like a deliberate re-auth and overwrite the fresh token.
    if( !last_source_hash || !last_tmpfile_hash ) {
        try {
            const initial = readFileSync( tmpfile_path, `utf-8` )
            const initial_hash = hash_credential_content( initial )
            last_source_hash = last_source_hash || initial_hash
            last_tmpfile_hash = last_tmpfile_hash || initial_hash
        } catch {
            // File may not exist yet
        }
    }

    const tick = async ( { throw_errors = false } = {} ) => {

        try {

            const source = await read_source()
            const source_hash = source ? hash_credential_content( source ) : null

            // A deliberate host-side reauthentication wins. Push it through
            // Docker's API before reading container state so a stale container
            // credential cannot overwrite the newly selected host account.
            if( source && source_hash !== last_source_hash ) {

                rewrite_tmpfile( tmpfile_path, source )
                if( transport ) await transport.push( tmpfile_path )

                last_source_hash = source_hash
                last_tmpfile_hash = source_hash
                log.debug( `Credential sync: host → container at ${ tmpfile_path }` )
                return

            }

            // Pull first when the credential was staged with docker cp. This
            // makes the local tmpfile the same observation point the legacy
            // bind-mount sync used, while remaining daemon-host independent.
            if( transport ) await transport.pull( tmpfile_path )

            // Docker copies can take long enough for the user to reauthenticate
            // on the host while one is in flight. Re-read after the await so
            // the source-wins policy applies to that window too; otherwise the
            // just-pulled, older container token could overwrite the new login.
            const latest_source = await read_source()
            const latest_source_hash = latest_source
                ? hash_credential_content( latest_source )
                : null

            if( latest_source_hash !== source_hash ) {
                if( latest_source ) {
                    rewrite_tmpfile( tmpfile_path, latest_source )
                    if( transport ) await transport.push( tmpfile_path )
                    last_tmpfile_hash = latest_source_hash
                }

                last_source_hash = latest_source_hash
                log.debug( `Credential sync: host changed during container pull; source retained` )
                return
            }

            let tmpfile_content = null
            try {
                tmpfile_content = readFileSync( tmpfile_path, `utf-8` )
            } catch {
                // tmpfile may have been removed (cleanup, etc.) — fall through
            }

            const tmpfile_hash = tmpfile_content ? hash_credential_content( tmpfile_content ) : null

            // Direction 2: tmpfile changed (common — in-container OAuth refresh).
            // Write back to the host source so the next babysit run starts with
            // valid tokens. Skipped when no write_destination was provided.
            if( tmpfile_content && write_destination && tmpfile_hash !== last_tmpfile_hash ) {

                await write_destination( tmpfile_content )
                last_source_hash = tmpfile_hash
                last_tmpfile_hash = tmpfile_hash
                log.debug( `Credential sync: tmpfile → host source` )

            }

        } catch ( e ) {
            log.debug( `Credential sync failed: ${ e.message }` )
            if( throw_errors ) throw e
        }

    }

    // Periodic ticks and the final stop flush share mutable hash state and the
    // same local file. Queue them so two Docker pulls cannot overlap or apply
    // conflict decisions against stale baselines.
    const queue_tick = ( options = {} ) => {
        const task = tick_queue.then( () => tick( options ) )
        tick_queue = task.catch( () => {} )
        return task
    }

    const interval = setInterval( () => {
        void queue_tick()
    }, REFRESH_INTERVAL_MS )

    // Don't let the refresh loop hold the event loop open. The supervised tmux
    // session is what should keep babysit alive; if that exits or the user
    // interrupts us, the cli should be free to terminate without waiting for
    // the next tick.
    interval.unref?.()

    return {
        set_transport: next_transport => {
            transport = next_transport
        },
        // Stop the periodic loop and run one last tick. The final flush is
        // load-bearing: if the in-container agent refreshed its OAuth token
        // less than REFRESH_INTERVAL_MS before session end, that refresh would
        // otherwise be lost — host source would still have the now-invalidated
        // refresh_token, breaking the next babysit session.
        stop: async () => {
            clearInterval( interval )
            await queue_tick( { throw_errors: true } )
        },
    }

}
