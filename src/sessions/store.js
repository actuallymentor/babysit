import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { SESSIONS_DIR, ensure_dirs } from '../utils/paths.js'
import { log } from '../utils/log.js'

/**
 * Save a session record to disk
 * @param {Object} session - Session metadata
 * @param {string} session.babysit_id - Babysit-assigned session identifier
 * @param {string} session.agent - Agent name
 * @param {string} [session.agent_session_id] - Agent's own session ID (captured later)
 * @param {string} session.tmux_session - Tmux session name
 * @param {string} session.pwd - Working directory
 * @param {string[]} session.modifiers - Active mode flags
 * @param {string} [session.creds_tmpfile] - Path to credentials tmpfile
 * @param {Object|null} [session.creds_sync_baseline] - Safe hashes from the
 *   credential capture handoff
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

    // Search by agent_session_id
    const files = readdirSync( SESSIONS_DIR ).filter( f => f.endsWith( `.json` ) )
    for( const file of files ) {
        const data = JSON.parse( readFileSync( join( SESSIONS_DIR, file ), `utf-8` ) )
        if( data.agent_session_id === id ) return data
    }

    return null

}

/**
 * List all stored sessions
 * @returns {Object[]} Array of session records
 */
export const list_stored_sessions = () => {

    ensure_dirs()
    const files = readdirSync( SESSIONS_DIR ).filter( f => f.endsWith( `.json` ) )

    return files.map( file => {
        try {
            return JSON.parse( readFileSync( join( SESSIONS_DIR, file ), `utf-8` ) )
        } catch {
            return null
        }
    } ).filter( Boolean )

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
