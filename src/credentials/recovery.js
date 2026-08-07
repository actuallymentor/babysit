import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'

import { CREDENTIAL_RECOVERY_DIR } from '../utils/paths.js'
import { log } from '../utils/log.js'

const safe_recovery_id = id => basename( String( id || `` ) ).replace( /[^a-zA-Z0-9_.-]/g, `-` )

/**
 * Persist ownership of credential copies that may be newer than their host
 * source. One file per Docker container keeps concurrent launches independent.
 * The record contains paths and identifiers only; credential contents stay in
 * their private 0700 transport directories and the stopped container.
 *
 * @param {Object} recovery - Recoverable launch state
 * @param {string|null} [recovery.container_id] - Docker container holding the staged credential
 * @param {string|null} [recovery.recovery_id] - Explicit owner id for pre-container state
 * @param {string[]} recovery.sync_paths - Private credential-sync directories
 * @param {Object} [options]
 * @param {string} [options.directory=CREDENTIAL_RECOVERY_DIR] - Registry directory
 * @returns {string|null} Recovery id, or null when no sync paths need protection
 */
export const register_credential_recovery = ( {
    container_id = null,
    recovery_id: requested_recovery_id = null,
    sync_paths = [],
}, {
    directory = CREDENTIAL_RECOVERY_DIR,
} = {} ) => {

    const protected_paths = [ ...new Set( sync_paths.filter( Boolean ) ) ]
    if( !protected_paths.length ) return null

    const recovery_id = safe_recovery_id(
        requested_recovery_id || container_id || `foreground-${ randomUUID() }`
    )

    mkdirSync( directory, { recursive: true, mode: 0o700 } )
    chmodSync( directory, 0o700 )

    const path = join( directory, `${ recovery_id }.json` )
    const pending_path = join( directory, `.${ recovery_id }.json.pending-${ process.pid }` )
    const record = {
        recovery_id,
        container_id,
        sync_paths: protected_paths,
        created_at: new Date().toISOString(),
    }

    try {
        writeFileSync( pending_path, JSON.stringify( record, null, 2 ), { mode: 0o600 } )
        chmodSync( pending_path, 0o600 )
        renameSync( pending_path, path )
    } catch ( error ) {
        rmSync( pending_path, { force: true } )
        throw error
    }

    return recovery_id

}

/**
 * Remove a recovery marker after its container was discarded or durable
 * session metadata took ownership of the same sync paths.
 *
 * @param {string|null} recovery_id - Registry identifier
 * @param {Object} [options]
 * @param {string} [options.directory=CREDENTIAL_RECOVERY_DIR] - Registry directory
 * @returns {boolean} Whether the marker is absent
 */
export const clear_credential_recovery = ( recovery_id, {
    directory = CREDENTIAL_RECOVERY_DIR,
} = {} ) => {

    if( !recovery_id ) return true

    try {
        rmSync( join( directory, `${ safe_recovery_id( recovery_id ) }.json` ), { force: true } )
        return true
    } catch ( error ) {
        log.warn( `Could not clear credential recovery marker ${ recovery_id }: ${ error.message }` )
        return false
    }

}

/**
 * Read every durable recovery marker. Malformed records are ignored without
 * making unrelated launches fail; their files remain in place for inspection.
 *
 * @param {Object} [options]
 * @param {string} [options.directory=CREDENTIAL_RECOVERY_DIR] - Registry directory
 * @returns {Object[]} Valid recovery records
 */
export const list_credential_recoveries = ( {
    directory = CREDENTIAL_RECOVERY_DIR,
} = {} ) => {

    if( !existsSync( directory ) ) return []

    let files
    try {
        files = readdirSync( directory ).filter( file => file.endsWith( `.json` ) )
    } catch ( error ) {
        log.debug( `Could not inspect credential recovery registry: ${ error.message }` )
        return []
    }

    return files.flatMap( file => {
        try {
            const record = JSON.parse( readFileSync( join( directory, file ), `utf-8` ) )
            if( !record.recovery_id || !Array.isArray( record.sync_paths ) ) return []
            return [ record ]
        } catch ( error ) {
            log.debug( `Could not read credential recovery marker ${ file }: ${ error.message }` )
            return []
        }
    } )

}
