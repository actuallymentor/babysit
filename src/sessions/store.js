import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, readdirSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'fs'
import { basename, join } from 'path'
import { SESSIONS_DIR, ensure_dirs } from '../utils/paths.js'
import { log } from '../utils/log.js'

// Missing or malformed timestamps belong after every valid session while
// preserving the original relative order between legacy records.
const session_started_at_ms = ( { started_at } ) => {

    const parsed = Date.parse( started_at )
    return Number.isNaN( parsed ) ? Number.NEGATIVE_INFINITY : parsed

}

/**
 * Sort session metadata by launch time without mutating the caller's array.
 * @param {Object[]} sessions - Stored session records
 * @returns {Object[]} Newest session records first
 */
export const sort_sessions_newest_first = ( sessions ) => [ ...sessions ].sort(
    ( a, b ) => session_started_at_ms( b ) - session_started_at_ms( a )
)

/**
 * Resolve the host workspace from which a session was launched.
 * @param {Object} session - Stored session metadata
 * @returns {string|null} Original workspace, including legacy `pwd` records
 */
export const session_original_workspace = ( session = {} ) =>
    session?.original_pwd || session?.pwd || null

/**
 * Resolve the writable workspace mounted into a session.
 * @param {Object} session - Stored session metadata
 * @returns {string|null} Clone workspace when present, otherwise the original workspace
 */
export const session_workspace = ( session = {} ) =>
    session?.clone_path || session_original_workspace( session )

/**
 * Replace a session record atomically so readers never observe partial JSON.
 * @param {string} path - Final session record path
 * @param {Object} session - Complete session metadata to write
 */
const write_session = ( path, session ) => {

    const pending_path = `${ path }.pending-${ process.pid }-${ randomUUID() }`

    try {
        writeFileSync( pending_path, JSON.stringify( session, null, 2 ), `utf-8` )
        renameSync( pending_path, path )
    } finally {
        rmSync( pending_path, { force: true } )
    }

}

/**
 * Save a session record to disk
 * @param {Object} session - Session metadata
 * @param {string} session.babysit_id - Babysit-assigned session identifier
 * @param {string|null} [session.name] - Optional human-readable session name
 * @param {string} session.agent - Agent name
 * @param {string} [session.agent_session_id] - Agent's own session ID (captured later)
 * @param {string} session.tmux_session - Tmux session name
 * @param {string} session.pwd - Original working directory retained for legacy consumers
 * @param {string} [session.original_pwd] - Canonical original workspace mounted at /original
 * @param {boolean} [session.clone] - Whether the session uses an isolated workspace copy
 * @param {string} [session.clone_path] - Host clone mounted at /workspace
 * @param {string} [session.clone_branch] - Git branch created in the clone
 * @param {string} [session.monitor_token] - Per-launch detached monitor identity
 * @param {string[]} session.modifiers - Active mode flags
 * @param {string} [session.creds_tmpfile] - Legacy active-agent credentials tmpfile
 * @param {Object} [session.creds_tmpfiles] - Per-agent credential tmpfiles
 * @param {Object|null} [session.creds_sync_baseline] - Safe hashes from the
 *   legacy active-agent credential capture handoff
 * @param {Object|null} [session.creds_sync_baselines] - Per-agent safe hashes
 *   from the credential capture handoff
 * @param {Object|null} [session.auth_cache_context] - Hash-only trust metadata
 *   used to preserve a fresh auth result across an in-session token rotation
 * @param {Object|null} [session.auth_cache_contexts] - Per-agent hash-only
 *   trust metadata for credentials available to nested coding-agent calls
 * @param {string|null} [session.agent_exit_sentinel] - Random token required
 *   to recognize the supervised entrypoint's early process-exit marker
 * @param {string|null} [session.container_id] - Docker container used for API credential sync
 * @param {number} [session.creds_sync_pid] - PID of credential sync daemon
 * @param {string} session.started_at - ISO timestamp
 * @param {Object} [options]
 * @param {string} [options.directory] - Session directory override for isolated callers
 */
export const save_session = ( session, { directory = SESSIONS_DIR } = {} ) => {

    if( directory === SESSIONS_DIR ) ensure_dirs()
    else mkdirSync( directory, { recursive: true } )

    const path = join( directory, `${ session.babysit_id }.json` )
    write_session( path, session )
    log.debug( `Session saved: ${ path }` )

}

/**
 * Update an existing session record (merge fields)
 * @param {string} babysit_id - The session identifier
 * @param {Object} updates - Fields to merge
 * @param {Object} [options]
 * @param {string} [options.directory] - Session directory override for isolated callers
 */
export const update_session = ( babysit_id, updates, { directory = SESSIONS_DIR } = {} ) => {

    const path = join( directory, `${ babysit_id }.json` )
    if( !existsSync( path ) ) return

    const existing = JSON.parse( readFileSync( path, `utf-8` ) )
    const updated = { ...existing, ...updates }
    write_session( path, updated )

}

/**
 * Inspect stored session files while retaining record mtimes and malformed-file details.
 * Destructive maintenance uses invalid_files to fail closed instead of silently
 * treating an unreadable registry as inactive.
 * @param {Object} [options]
 * @param {string} [options.directory] - Session directory override for isolated callers
 * @returns {{ records: Array<{ session: Object, path: string, updated_at: string }>, invalid_files: string[] }}
 */
export const inspect_stored_sessions = ( { directory = SESSIONS_DIR } = {} ) => {

    if( directory === SESSIONS_DIR ) ensure_dirs()
    else mkdirSync( directory, { recursive: true } )

    const files = readdirSync( directory ).filter( file => file.endsWith( `.json` ) )
    const invalid_files = []
    const records = files.flatMap( file => {
        const path = join( directory, file )

        try {
            const entry = lstatSync( path )
            if( entry.isSymbolicLink() || !entry.isFile() ) {
                throw new Error( `Session record must be a regular file` )
            }

            const session = JSON.parse( readFileSync( path, `utf-8` ) )
            if( !session || typeof session !== `object` || Array.isArray( session ) ) {
                throw new Error( `Session record must be an object` )
            }
            if( typeof session.babysit_id !== `string` || basename( file, `.json` ) !== session.babysit_id ) {
                throw new Error( `Session id must match its filename` )
            }

            const updated_at = entry.mtime.toISOString()
            return [ { session, path, updated_at } ]
        } catch {
            invalid_files.push( path )
            return []
        }
    } ).sort( ( a, b ) => session_started_at_ms( b.session ) - session_started_at_ms( a.session ) )

    return { records, invalid_files }

}

/**
 * List all stored sessions
 * @param {Object} [options]
 * @param {string} [options.directory] - Session directory override for isolated callers
 * @returns {Object[]} Array of session records, newest first
 */
export const list_stored_sessions = ( { directory = SESSIONS_DIR } = {} ) => {

    return inspect_stored_sessions( { directory } ).records.map( ( { session } ) => session )

}

/**
 * Load a session record by babysit ID or agent session ID
 * @param {string} id - Either the babysit_id or agent_session_id
 * @param {Object} [options]
 * @param {string} [options.directory] - Session directory override for isolated callers
 * @returns {Object|null} Session data or null
 */
export const load_session = ( id, { directory = SESSIONS_DIR } = {} ) => {

    if( directory === SESSIONS_DIR ) ensure_dirs()
    else mkdirSync( directory, { recursive: true } )

    // Try direct match on babysit_id
    const direct = join( directory, `${ id }.json` )
    if( existsSync( direct ) ) {
        try {
            return JSON.parse( readFileSync( direct, `utf-8` ) )
        } catch ( error ) {
            log.warn( `Ignoring malformed session record ${ direct }: ${ error.message }` )
        }
    }

    // Resuming a conversation creates another Babysit launch record with the
    // same native id. Prefer the newest launch so cwd, modes, and name reflect
    // the latest state instead of relying on filesystem iteration order.
    return list_stored_sessions( { directory } )
        .find( session => session.agent_session_id === id ) || null

}

/**
 * Generate a new babysit session ID
 * @returns {string} e.g. "20260428-110000-a1b2c3d4e5f6"
 */
export const generate_session_id = () => {

    const now = new Date()
    const date = now.toISOString().replace( /[-:T]/g, `` ).slice( 0, 14 ).replace( /(\d{8})(\d{6})/, `$1-$2` )
    const rand = randomUUID().replaceAll( `-`, `` ).slice( 0, 12 )
    return `${ date }-${ rand }`

}
