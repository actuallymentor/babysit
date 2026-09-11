import { start_credential_sync } from './refresh.js'

/**
 * Decode go-keyring's macOS storage envelope, retaining legacy plain secrets.
 * @param {string|null} value - Output from security find-generic-password -w
 * @returns {string|null} Native secret content, or null for a malformed envelope
 */
export const decode_keyring_secret = value => {

    if( !value ) return null
    for( const [ prefix, encoding ] of [ [ `go-keyring-base64:`, `base64` ], [ `go-keyring-encoded:`, `hex` ] ] ) {
        if( !value.startsWith( prefix ) ) continue
        const encoded = value.slice( prefix.length )
        const decoded = Buffer.from( encoded, encoding )
        // Buffer decoding is permissive; malformed keychain content must fall
        // back cleanly instead of staging a truncated credential.
        if( decoded.toString( encoding ) !== ( encoding === `hex` ? encoded.toLowerCase() : encoded ) ) return null
        return decoded.toString( `utf8` )
    }
    return value

}

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
