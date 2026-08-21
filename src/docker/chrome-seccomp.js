import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

import { build_private_tmpfile } from '../utils/tmpfile.js'
import chrome_seccomp_profile from './chrome-seccomp.json' with { type: 'json' }

// Docker's built-in profile cannot be extended in place. Keep its current
// allowlist and security fixes, then add only the namespace calls Chrome needs
// to establish its stricter renderer sandbox without CAP_SYS_ADMIN.
export const CHROME_SECCOMP_SOURCE = `moby/moby@b612274c5489b546ff8b4a4f93f25a0b8952713a`
export const CHROME_SECCOMP_SOURCE_SHA256 = `536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`

const chrome_seccomp_content = `${ JSON.stringify( chrome_seccomp_profile, null, 2 ) }\n`

/**
 * Create a private, launch-scoped Chrome seccomp profile.
 * @param {Object} [options]
 * @param {Function} [options.build_private_file=build_private_tmpfile] - Private file builder
 * @returns {{ directory: string, file: string }} Private profile transport
 */
export const create_chrome_seccomp_profile = ( {
    build_private_file = build_private_tmpfile,
} = {} ) => {

    const transport = build_private_file(
        `chrome`,
        `chrome-seccomp.json`,
        chrome_seccomp_content
    )

    if( !transport?.directory || !transport?.file ) {
        throw new Error( `Could not build Chrome's private seccomp profile` )
    }

    return transport

}

/**
 * Materialize the embedded profile at an explicitly owned destination.
 * Production launch controllers use create_chrome_seccomp_profile() instead
 * so each launch owns a private path with an explicit cleanup boundary.
 *
 * @param {Object} [options]
 * @param {string} options.path - Explicit destination path
 * @returns {string} Materialized profile path
 */
export const ensure_chrome_seccomp_profile = ( {
    path,
} = {} ) => {

    if( !path ) throw new Error( `A Chrome seccomp profile destination is required` )

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
    } finally {
        rmSync( temporary_path, { force: true } )
    }

    return path

}
