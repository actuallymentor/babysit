import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { BABYSIT_DIR } from '../utils/paths.js'
import chrome_seccomp_profile from './chrome-seccomp.json' with { type: 'json' }

// Docker's built-in profile cannot be extended in place. Keep its current
// allowlist and security fixes, then add only the namespace calls Chrome needs
// to establish its stricter renderer sandbox without CAP_SYS_ADMIN.
export const CHROME_SECCOMP_SOURCE = `moby/moby@b612274c5489b546ff8b4a4f93f25a0b8952713a`
export const CHROME_SECCOMP_PROFILE_PATH = join( BABYSIT_DIR, `chrome-seccomp.json` )

const chrome_seccomp_content = `${ JSON.stringify( chrome_seccomp_profile, null, 2 ) }\n`

/**
 * Materialize the embedded Chrome seccomp profile for the external Docker CLI.
 * Bun embeds JSON inside compiled binaries, so Docker cannot read the original
 * module path directly. Atomic replacement also keeps concurrent launches from
 * observing a partially-written profile.
 *
 * @param {Object} [options]
 * @param {string} [options.path=CHROME_SECCOMP_PROFILE_PATH] - Destination path
 * @returns {string} Materialized profile path
 */
export const ensure_chrome_seccomp_profile = ( {
    path = CHROME_SECCOMP_PROFILE_PATH,
} = {} ) => {

    try {
        if( readFileSync( path, `utf8` ) === chrome_seccomp_content ) {
            chmodSync( path, 0o600 )
            return path
        }
    } catch {
        // Missing or unreadable state is replaced below.
    }

    mkdirSync( dirname( path ), { recursive: true } )
    const temporary_path = `${ path }.${ process.pid }.${ randomUUID() }.tmp`

    try {
        writeFileSync( temporary_path, chrome_seccomp_content, {
            mode: 0o600,
            flag: `wx`,
        } )
        renameSync( temporary_path, path )
        chmodSync( path, 0o600 )
    } finally {
        rmSync( temporary_path, { force: true } )
    }

    return path

}
