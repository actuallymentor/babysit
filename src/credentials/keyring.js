import { start_credential_sync } from './refresh.js'

/**
 * Keep keyring captures source-only and retain their origin across monitor handoff.
 * A locked desktop keyring must never turn a staged secret into a host file write.
 * @param {Function} read_source - Read the native keyring's raw credential JSON
 * @param {string} tmpfile - Existing private credential transport
 * @param {Object|null} baseline - Foreground hashes when reconnecting a monitor
 * @returns {Object} Credential sync controller with persistent source metadata
 */
export const start_keyring_sync = ( read_source, tmpfile, baseline = null ) => {

    const sync = start_credential_sync( read_source, tmpfile, null, baseline || {} )
    const read_baseline = sync.baseline
    sync.baseline = () => ( { ...read_baseline(), credential_source: `keyring` } )
    return sync

}
