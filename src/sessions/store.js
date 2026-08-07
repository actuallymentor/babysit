import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
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
 * Save a session record to disk
 * @param {Object} session - Session metadata
 * @param {string} session.babysit_id - Babysit-assigned session identifier
 * @param {string|null} [session.name] - Optional human-readable session name
 * @param {string} session.agent - Agent name
 * @param {string} [session.agent_session_id] - Agent's own session ID (captured later)
 * @param {string} session.tmux_session - Tmux session name
 * @param {string} session.pwd - Working directory
 * @param {string[]} session.modifiers - Active mode flags
 * @param {string} [session.creds_tmpfile] - Legacy active-agent credentials tmpfile
 * @param {Object} [session.creds_tmpfiles] - Per-agent credential tmpfiles
 * @param {Object|null} [session.creds_sync_baseline] - Safe hashes from the
 *   legacy active-agent credential capture handoff
 * @param {Object|null} [session.creds_sync_baselines] - Per-agent safe hashes
 *   from the credential capture handoff
 * @param {string|null} [session.container_id] - Docker container used for API credential sync
 * @param {number} [session.creds_sync_pid] - PID of credential sync daemon
 * @param {string} session.started_at - ISO timestamp
 */
export const save_session = ( session ) => {

    ensure_dirs()
    const path = join( SESSIONS_DIR, `${ session.babysit_id }.json` )
    writeFileSync( path, JSON.stringify( session, null, 2 ), `utf-8` )
    log.debug( `Session saved: ${ path }` )

}

/**
 * Update an existing session record (merge fields)
 * @param {string} babysit_id - The session identifier
 * @param {Object} updates - Fields to merge
 */
export const update_session = ( babysit_id, updates ) => {

    const path = join( SESSIONS_DIR, `${ babysit_id }.json` )
    if( !existsSync( path ) ) return

    const existing = JSON.parse( readFileSync( path, `utf-8` ) )
    const updated = { ...existing, ...updates }
    writeFileSync( path, JSON.stringify( updated, null, 2 ), `utf-8` )

}

/**
 * List all stored sessions
 * @returns {Object[]} Array of session records, newest first
 */
export const list_stored_sessions = () => {

    ensure_dirs()
    const files = readdirSync( SESSIONS_DIR ).filter( f => f.endsWith( `.json` ) )

    const sessions = files.map( file => {
        try {
            return JSON.parse( readFileSync( join( SESSIONS_DIR, file ), `utf-8` ) )
        } catch {
            return null
        }
    } ).filter( Boolean )

    // Invalid or missing legacy timestamps fall to the end without making the
    // listing fail.
    return sort_sessions_newest_first( sessions )

}

/**
 * Load a session record by babysit ID or agent session ID
 * @param {string} id - Either the babysit_id or agent_session_id
 * @returns {Object|null} Session data or null
 */
export const load_session = ( id ) => {

    ensure_dirs()

    // Try direct match on babysit_id
    const direct = join( SESSIONS_DIR, `${ id }.json` )
    if( existsSync( direct ) ) {
        return JSON.parse( readFileSync( direct, `utf-8` ) )
    }

    // Resuming a conversation creates another Babysit launch record with the
    // same native id. Prefer the newest launch so cwd, modes, and name reflect
    // the latest state instead of relying on filesystem iteration order.
    return list_stored_sessions().find( session => session.agent_session_id === id ) || null

}

/**
 * Generate a new babysit session ID
 * @returns {string} e.g. "20260428-110000-a1b2"
 */
export const generate_session_id = () => {

    const now = new Date()
    const date = now.toISOString().replace( /[-:T]/g, `` ).slice( 0, 14 ).replace( /(\d{8})(\d{6})/, `$1-$2` )
    const rand = Math.random().toString( 16 ).slice( 2, 6 )
    return `${ date }-${ rand }`

}
