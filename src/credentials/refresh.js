import { mkdirSync, readFileSync, rmSync, watch } from 'fs'
import { createHash } from 'crypto'
import { basename, dirname } from 'path'

import { log } from '../utils/log.js'
import { rewrite_tmpfile } from '../utils/tmpfile.js'
import { write_atomic_json } from '../web_bridge/files.js'

/*
 * Credential sync between a host login and its staged copy in a container.
 *
 * State lives in a small JSON file under BABYSIT_DIR (durable across reboot,
 * unlike tmpdir): `{ tmpfile, source_hash, synced_hash, credential_source }`.
 * Hashes only, never secrets. `source_hash` is the host login last seen,
 * `synced_hash` the copy both sides last agreed on. One stateless
 * `reconcile( store, transport )` reads it, acts, and writes it back; the
 * foreground launch, the detached monitor and clone recovery all drive the
 * same function through `start_credential_sync` (queue + timer + watcher).
 *
 * Crash ordering: every tick writes the credential copy (local sync file or
 * host file) BEFORE the state. A crash in between leaves a state that lags
 * the files; the next reconcile then sees a "change" whose content is
 * already in place and re-pushes identical bytes. Never the reverse, which
 * could mark a rotation as delivered while only one side has it.
 */

/**
 * Hash credential content without persisting the secret itself.
 * @param {string} content - Credential file content
 * @returns {string} SHA-256 hash
 */
export const hash_credential_content = ( content ) => createHash( `sha256` ).update( content ).digest( `hex` )

/**
 * Build the hash baseline for a host credential file and its staged sync copy.
 * @param {string} source_path - Host credential path
 * @param {string} tmpfile_path - Staged sync copy path
 * @returns {{ baseline_source_hash: string, baseline_tmpfile_hash: string }|null}
 */
export const build_credential_sync_baseline = ( source_path, tmpfile_path ) => {

    try {
        return {
            baseline_source_hash: hash_credential_content( readFileSync( source_path, `utf-8` ) ),
            baseline_tmpfile_hash: hash_credential_content( readFileSync( tmpfile_path, `utf-8` ) ),
        }
    } catch {
        return null
    }

}

/**
 * Read a durable sync state file. Missing or corrupt reads as null.
 * @param {string} path - State file
 * @returns {Object|null} State
 */
export const read_sync_state = path => {
    try {
        const state = JSON.parse( readFileSync( path, `utf-8` ) )
        return state && typeof state.tmpfile === `string` ? state : null
    } catch {
        return null
    }
}

/**
 * Write a sync state file atomically, 0600, creating its directory.
 * @param {string} path - State file
 * @param {Object} state - State to persist
 */
export const write_sync_state = ( path, state ) => {
    mkdirSync( dirname( path ), { recursive: true, mode: 0o700 } )
    write_atomic_json( path, { ...state, updated_at: new Date().toISOString() } )
}

/**
 * Remove a sync state file after its final flush succeeded.
 * @param {string|null} path - State file
 * @returns {boolean} Whether it is gone
 */
export const remove_sync_state = path => {
    if( !path ) return true
    try {
        rmSync( path, { force: true } )
        return true
    } catch ( error ) {
        log.warn( `Could not remove credential sync state ${ path }: ${ error.message }` )
        return false
    }
}

// A file store persists every decision; a memory store serves tests and
// throwaway controllers that never hand off
const file_store = path => ( { read: () => read_sync_state( path ), write: state => write_sync_state( path, state ), path } )
const memory_store = initial => {
    let state = initial
    return { read: () => state, write: next => state = { ...next }, path: null }
}

// Refresh interval for credential sync daemon (5 minutes)
const REFRESH_INTERVAL_MS = 300_000
const WATCH_DEBOUNCE_MS = 200

// Codex stores a JSON object. Never forward a partial write or include its
// secret content in a parser error. Absence is handled separately as logout.
const validate_source = ( content ) => {
    try {
        const value = JSON.parse( content )
        if( value && typeof value === `object` && !Array.isArray( value ) ) return
    } catch { /* Retry after the next file event or periodic reconciliation. */ }

    throw new Error( `Host credential file is missing or incomplete; retaining sync state` )
}

const read_copy = path => {
    try {
        return readFileSync( path, `utf-8` )
    } catch {
        return null
    }
}

/**
 * One reconciliation pass, stateless apart from the store:
 *   1. A changed host login wins: write it into the copy, push it into the
 *      container, then record it.
 *   2. Otherwise pull the container's copy. If that changed (an in-container
 *      OAuth refresh), write it back to the host, then record it.
 * The host is re-read after every Docker pull, so a re-login during the
 * pull still wins (gotcha 83).
 *
 * @param {Object} store - { read, write } over the sync state
 * @param {Object|null} transport - { push, pull } into the container, or null before it exists
 * @param {Object} options
 * @param {Function} options.read_source - Async host login reader (null = absent)
 * @param {Function|null} [options.write_destination] - Async host writer; null keeps sync one-way
 * @param {boolean} [options.file_required=false] - Absent host file = logout; validate JSON
 * @param {boolean} [options.source_only=false] - Only react to a host change (watch events)
 * @returns {Promise<{ source_changed: boolean, pulled: boolean }>}
 */
export const reconcile = async ( store, transport, {
    read_source,
    write_destination = null,
    file_required = false,
    source_only = false,
} ) => {

    const state = store.read()
    const { tmpfile } = state
    const save = changes => store.write( { ...state, ...changes } )

    const read_host = async () => {
        const source = await read_source()
        if( file_required && source !== null ) validate_source( source )
        return source
    }

    const source = await read_host()

    // Logout deletes the file. Do not resurrect that login from the container
    // or block shutdown; a later file recreation wins even if it restores the
    // same content as the previous host login.
    if( file_required && source === null ) {
        save( { source_hash: null } )
        return { source_changed: true, pulled: false }
    }

    const source_hash = source ? hash_credential_content( source ) : null

    if( source && source_hash !== state.source_hash ) {

        // No container yet: leave the state alone so the change is still
        // visible when the transport connects. Recording it now would mark the
        // login delivered while only the local copy has it.
        if( !transport ) {
            log.debug( `Credential sync: host changed before the container connected; deferring` )
            return { source_changed: false, pulled: false }
        }

        rewrite_tmpfile( tmpfile, source )
        await transport.push( tmpfile )
        save( { source_hash, synced_hash: source_hash } )
        log.debug( `Credential sync: host → container at ${ tmpfile }` )
        return { source_changed: true, pulled: false }

    }

    // Watch events include our own writeback and unrelated directory
    // activity. An unchanged host file must not cause a Docker pull.
    if( source_only ) return { source_changed: false, pulled: false }

    if( transport ) await transport.pull( tmpfile )

    // Docker copies can take long enough for a host re-login to land
    const latest = await read_host()
    if( file_required && latest === null ) {
        save( { source_hash: null } )
        return { source_changed: true, pulled: false }
    }
    const latest_hash = latest ? hash_credential_content( latest ) : null

    if( latest_hash !== source_hash ) {
        if( latest ) {
            rewrite_tmpfile( tmpfile, latest )
            if( transport ) await transport.push( tmpfile )
        }
        save( { source_hash: latest_hash, ...latest && { synced_hash: latest_hash } } )
        log.debug( `Credential sync: host changed during container pull; source retained` )
        return { source_changed: true, pulled: false }
    }

    const copy = read_copy( tmpfile )
    const copy_hash = copy ? hash_credential_content( copy ) : null

    // Direction 2: the copy changed (in-container OAuth refresh). The host
    // write comes first; the state only records what already landed.
    if( copy && write_destination && copy_hash !== state.synced_hash ) {
        await write_destination( copy )
        save( { source_hash: copy_hash, synced_hash: copy_hash } )
        log.debug( `Credential sync: tmpfile → host source` )
        return { source_changed: false, pulled: true }
    }

    return { source_changed: false, pulled: false }

}

/**
 * Start a credential sync controller around `reconcile`: a 5-minute timer,
 * a serialized tick queue, and (for required host files) a directory watcher.
 *
 * Writes to the local sync copy stay in-place (Docker inode tracking).
 *
 * @param {Function} read_source - Async function returning the current host credential string
 * @param {string} tmpfile_path - Client-local credential sync copy
 * @param {Function|null} [write_destination=null] - Async host writer; null keeps sync one-way
 * @param {Object} [options]
 * @param {string|null} [options.state_path] - Durable state file; existing state is resumed
 * @param {string|null} [options.source_path] - Host file whose absence is logout; watched once connected
 * @param {string|null} [options.baseline_source_hash] - Seed: host hash at capture
 * @param {string|null} [options.baseline_tmpfile_hash] - Seed: copy hash at capture
 * @param {string|null} [options.credential_source] - Source kind (file/keyring) kept in the state
 * @returns {Object} Sync controller
 */
export const start_credential_sync = ( read_source, tmpfile_path, write_destination = null, options = {} ) => {

    const {
        state_path = null,
        source_path = null,
        baseline_source_hash = null,
        baseline_tmpfile_hash = null,
        credential_source = null,
    } = options

    // Resume a durable state (monitor handoff, recovery), else seed one. At
    // capture the copy equals the source; explicit hashes win because the
    // agent can refresh the copy before a monitor reattaches.
    const resumed = state_path ? read_sync_state( state_path ) : null
    const seed = () => {
        const initial = read_copy( tmpfile_path )
        const initial_hash = initial ? hash_credential_content( initial ) : null
        const source_hash = baseline_source_hash || initial_hash
        return {
            tmpfile: tmpfile_path,
            source_hash,
            synced_hash: baseline_tmpfile_hash || baseline_source_hash || initial_hash,
            ...credential_source && { credential_source },
        }
    }
    const initial = resumed
        ? { ...resumed, tmpfile: tmpfile_path, ...credential_source && { credential_source } }
        : seed()
    const store = state_path ? file_store( state_path ) : memory_store( initial )
    if( state_path ) store.write( initial )

    let source_changed = false
    const pull_handlers = []
    let transport = null
    let tick_queue = Promise.resolve()
    let watcher = null
    let watch_timer = null
    let stopped = false

    const tick = async ( { throw_errors = false, source_only = false } = {} ) => {
        try {
            const result = await reconcile( store, transport, {
                read_source,
                write_destination,
                file_required: Boolean( source_path ),
                source_only,
            } )
            if( result.source_changed ) source_changed = true
            // A trusted in-session rotation reached the host file. Listeners
            // re-stamp caches keyed on the previous content.
            if( result.pulled ) pull_handlers.forEach( handler => {
                try {
                    handler()
                } catch ( error ) {
                    log.debug( `Credential pull listener failed: ${ error.message }` )
                }
            } )
        } catch ( e ) {
            log.debug( `Credential sync failed: ${ e.message }` )
            if( throw_errors ) throw e
        }
    }

    // Periodic ticks and the final stop flush share the state and the local
    // file. Queue them so two Docker pulls never overlap.
    const queue_tick = ( tick_options = {} ) => {
        const task = tick_queue.then( () => tick( tick_options ) )
        tick_queue = task.catch( () => {} )
        return task
    }

    const watch_source = () => {
        if( !source_path || watcher || stopped ) return

        try {
            // Watch the directory: atomic login writes replace the file's
            // inode, leaving a file watcher attached to the previous login.
            watcher = watch( dirname( source_path ), { persistent: false }, ( event, filename ) => {
                // Some runtimes coalesce a rename pair to its temporary name.
                // Recheck on any rename; the content hash prevents extra copies.
                if( stopped ) return
                if( event !== `rename` && filename && filename.toString() !== basename( source_path ) ) return
                clearTimeout( watch_timer )
                watch_timer = setTimeout( () => {
                    void queue_tick( { source_only: true } )
                }, WATCH_DEBOUNCE_MS )
                watch_timer.unref?.()
            } )
            watcher.on( `error`, () => {
                watcher?.close()
                watcher = null
                log.warn( `Credential watcher unavailable; periodic sync remains active` )
            } )
        } catch {
            log.warn( `Credential watcher unavailable; periodic sync remains active` )
        }
    }

    const interval = setInterval( () => {
        void queue_tick()
    }, REFRESH_INTERVAL_MS )

    // The supervised tmux session keeps babysit alive, not this loop
    interval.unref?.()

    return {
        state_path,
        baseline: () => {
            const state = store.read() || {}
            return {
                baseline_source_hash: state.source_hash ?? null,
                baseline_tmpfile_hash: state.synced_hash ?? null,
                ...state.credential_source && { credential_source: state.credential_source },
            }
        },
        source_changed: () => source_changed,
        // Observe each container → host writeback of a rotated credential.
        on_pull: handler => {
            pull_handlers.push( handler )
        },
        set_transport: next_transport => {
            transport = next_transport
            if( source_path && transport && !stopped ) {
                watch_source()
                // Close the capture-to-connect gap without consuming changes
                // before the initial Docker credential copy has been staged.
                void queue_tick( { source_only: true } )
            }
        },
        // Reconcile now without stopping (auth probes, logout re-stage)
        flush: async () => queue_tick( { throw_errors: true } ),
        // Stop the loop and run one last tick. The final flush is load-bearing:
        // a refresh less than REFRESH_INTERVAL_MS before session end would
        // otherwise leave the host with a now-invalidated refresh token.
        stop: async () => {
            stopped = true
            watcher?.close()
            clearTimeout( watch_timer )
            clearInterval( interval )
            await queue_tick( { throw_errors: true } )
        },
    }

}
