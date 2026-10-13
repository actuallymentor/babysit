import { randomUUID } from 'crypto'
import { chmodSync, renameSync, rmSync, writeFileSync } from 'fs'

/**
 * Replace a private JSON file atomically so readers never see a partial write.
 * @param {string} path - Destination file
 * @param {*} value - JSON-serializable value
 */
export const write_atomic_json = ( path, value ) => {

    const pending_path = `${ path }.pending-${ process.pid }-${ randomUUID() }`

    try {
        writeFileSync( pending_path, `${ JSON.stringify( value ) }\n`, { mode: 0o600 } )
        chmodSync( pending_path, 0o600 )
        renameSync( pending_path, path )
    } finally {
        rmSync( pending_path, { force: true } )
    }

}
