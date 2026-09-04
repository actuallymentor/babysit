import { createHash, randomBytes, randomUUID } from 'crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

import { WEB_BRIDGE_DIR, WEB_BRIDGE_PROTOCOL, web_bridge_paths } from './paths.js'

/**
 * Hash an access token without retaining the bearer secret on disk.
 * @param {string} token - Plaintext access token
 * @returns {string} SHA-256 hex digest
 */
export const hash_web_token = token => createHash( `sha256` ).update( token ).digest( `hex` )

/**
 * Atomically replace a private JSON file.
 * @param {string} path - Destination path
 * @param {Object} value - JSON value
 */
const write_private_json = ( path, value ) => {

    const pending_path = `${ path }.pending-${ process.pid }-${ randomUUID() }`

    try {
        writeFileSync( pending_path, `${ JSON.stringify( value, null, 2 ) }\n`, { mode: 0o600 } )
        chmodSync( pending_path, 0o600 )
        renameSync( pending_path, path )
    } finally {
        rmSync( pending_path, { force: true } )
    }

}

const ensure_private_directory = path => {

    if( existsSync( path ) ) {
        const entry = lstatSync( path )
        if( entry.isSymbolicLink() || !entry.isDirectory() ) {
            throw new Error( `Web bridge path is not a real directory: ${ path }` )
        }
    } else {
        mkdirSync( path, { recursive: true, mode: 0o700 } )
    }

    chmodSync( path, 0o700 )

}

/**
 * Create or rotate the host-side web bridge capability.
 * @param {Object} [options]
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 * @param {Function} [options.random_bytes=randomBytes] - Entropy seam for tests
 * @param {Function} [options.now_fn=Date.now] - Clock seam for tests
 * @returns {{ token: string, paths: Object, access: Object }} One-time plaintext token and persisted metadata
 */
export const initialize_web_bridge = ( {
    directory = WEB_BRIDGE_DIR,
    random_bytes = randomBytes,
    now_fn = Date.now,
} = {} ) => {

    const paths = web_bridge_paths( directory )
    const directories = [ paths.root, paths.access_dir, paths.state, paths.requests, paths.inflight ]

    directories.forEach( ensure_private_directory )

    const token = random_bytes( 32 ).toString( `base64url` )
    const access = {
        protocol: WEB_BRIDGE_PROTOCOL,
        token_sha256: hash_web_token( token ),
        role: `write`,
        updated_at: new Date( now_fn() ).toISOString(),
    }

    // Keep the config adjacent to, but outside, the writable request mount.
    mkdirSync( dirname( paths.access ), { recursive: true, mode: 0o700 } )
    write_private_json( paths.access, access )

    return { token, paths, access }

}
