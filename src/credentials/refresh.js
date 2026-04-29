import { readFileSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { log } from '../utils/log.js'

const quick_hash = ( str ) => createHash( `sha256` ).update( str ).digest( `hex` )

// Refresh interval for credential sync daemon (5 minutes)
const REFRESH_INTERVAL_MS = 300_000

/**
 * Start a background credential sync loop that periodically
 * re-reads the source credential and writes in-place to the tmpfile.
 * Uses content hashing to avoid unnecessary writes.
 *
 * IMPORTANT: writes in-place via writeFileSync, never mv/rename.
 * Docker bind mounts track inodes — mv creates a new inode and breaks the mount.
 *
 * @param {Function} read_source - Async function that returns current credential string
 * @param {string} tmpfile_path - Path to the tmpfile mounted into docker
 * @returns {{ stop: Function }} Controller with stop method
 */
export const start_credential_sync = ( read_source, tmpfile_path ) => {

    let last_hash = null
    let running = true

    // Read initial hash
    try {
        const initial = readFileSync( tmpfile_path, `utf-8` )
        last_hash = quick_hash( initial )
    } catch {
        // File may not exist yet
    }

    const tick = async () => {

        if( !running ) return

        try {

            const fresh = await read_source()
            if( !fresh ) return

            const fresh_hash = quick_hash( fresh )

            if( fresh_hash !== last_hash ) {
                // Write in-place — never mv (Docker inode tracking)
                writeFileSync( tmpfile_path, fresh, { mode: 0o666 } )
                last_hash = fresh_hash
                log.debug( `Credentials refreshed at ${ tmpfile_path }` )
            }

        } catch ( e ) {
            log.debug( `Credential refresh failed: ${ e.message }` )
        }

    }

    const interval = setInterval( tick, REFRESH_INTERVAL_MS )

    // Don't let the refresh loop hold the event loop open. The supervised tmux
    // session is what should keep babysit alive; if that exits or the user
    // interrupts us, the cli should be free to terminate without waiting for
    // the next tick.
    interval.unref?.()

    return {
        stop: () => {
            running = false
            clearInterval( interval )
        },
    }

}
