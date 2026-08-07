import { existsSync, readFileSync, writeFileSync, chmodSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename, dirname } from 'path'

import { log } from './log.js'

// Why every writable tmpfile we stage or bind needs an explicit chmod 666:
// Node's `fs.writeFileSync(path, data, { mode: 0o666 })` is masked by the
// host user's umask (typically 0o022 → 0o644 or 0o002 → 0o664). The
// container may initially see a root-owned docker-cp destination before uid
// remapping. Several agents update their state file in place during init; a
// silent EACCES leaves the TUI hanging mid-render. Credential copies live
// inside a 0700 host directory even though their inner sync file is 0666.

/**
 * Copy a host file to a fresh chmod-666 tmpfile so the container's `node`
 * user can both read AND write it. Returns null if the source is missing
 * or unreadable so callers can skip the mount silently.
 *
 * @param {string} host_path - Source file on host (must exist)
 * @param {string} tag - Short identifier baked into the tmpfile name (typically the agent name)
 * @param {(content: string) => string} [transform] - Optional content rewrite before write
 * @returns {string|null} Tmpfile path, or null if source missing/unreadable
 */
export const copy_host_file_to_tmpfile = ( host_path, tag, transform ) => {

    try {

        if( !existsSync( host_path ) ) return null

        let content = readFileSync( host_path, `utf-8` )
        if( transform ) content = transform( content )

        const tmpfile = join( tmpdir(), `babysit-${ tag }-${ basename( host_path ) }-${ Date.now() }` )
        writeFileSync( tmpfile, content )
        chmodSync( tmpfile, 0o666 )

        return tmpfile

    } catch ( e ) {
        log.debug( `Failed to copy ${ host_path } to tmpfile: ${ e.message }` )
        return null
    }

}

/**
 * Build a fresh chmod-666 tmpfile from in-memory content (no host source).
 * Used when babysit synthesises a file that has no equivalent on the host
 * (e.g. gemini's `trustedFolders.json` for users who never trusted a folder
 * via the gemini CLI).
 *
 * @param {string} tag - Short identifier baked into the tmpfile name
 * @param {string} hint - Filename hint (e.g. "trustedFolders.json")
 * @param {string} content - File content to write
 * @returns {string|null} Tmpfile path, or null on error
 */
export const build_tmpfile = ( tag, hint, content ) => {

    try {

        const tmpfile = join( tmpdir(), `babysit-${ tag }-${ hint }-${ Date.now() }` )
        writeFileSync( tmpfile, content )
        chmodSync( tmpfile, 0o666 )
        return tmpfile

    } catch ( e ) {
        log.debug( `Failed to build tmpfile (${ hint }): ${ e.message }` )
        return null
    }

}

/**
 * Build a private tmpfile inside a private temporary directory. Unlike agent
 * state tmpfiles, this is suitable for secrets that only the host-side Docker
 * client needs to read and never needs to expose through a bind mount.
 *
 * @param {string} tag - Short identifier baked into the tmpdir name
 * @param {string} hint - Filename hint used for the file inside the directory
 * @param {string} content - File content to write
 * @param {Object} [options]
 * @param {number} [options.file_mode=0o600] - File permissions inside the private directory
 * @returns {{ directory: string, file: string }|null} Private paths, or null on error
 */
export const build_private_tmpfile = ( tag, hint, content, {
    file_mode = 0o600,
} = {} ) => {

    let directory = null

    try {

        directory = mkdtempSync( join( tmpdir(), `babysit-${ tag }-${ hint }-` ) )
        const file = join( directory, hint )

        chmodSync( directory, 0o700 )
        writeFileSync( file, content, { mode: file_mode } )
        chmodSync( file, file_mode )

        return { directory, file }

    } catch ( e ) {
        if( directory ) rmSync( directory, { recursive: true, force: true } )
        log.debug( `Failed to build private tmpfile (${ hint }): ${ e.message }` )
        return null
    }

}

/**
 * Copy a host credential into a private sync directory. The file is writable
 * after Docker copies it as root, while the 0700 parent keeps other host users
 * from traversing to it.
 *
 * @param {string} host_path - Credential source path
 * @param {string} tag - Agent identifier used in the private directory name
 * @returns {{ directory: string, file: string }|null} Private sync paths
 */
export const copy_host_file_to_private_tmpfile = ( host_path, tag ) => {

    try {
        if( !existsSync( host_path ) ) return null

        return build_private_tmpfile(
            `creds-${ tag }`,
            basename( host_path ),
            readFileSync( host_path, `utf-8` ),
            { file_mode: 0o666 }
        )
    } catch ( error ) {
        log.debug( `Failed to copy ${ host_path } to a private sync file: ${ error.message }` )
        return null
    }

}

/**
 * Identify private credential-sync directories without ever treating the
 * broad system temp directory as a cleanup target. Legacy flat tmpfiles return
 * null and remain compatible with older session metadata.
 *
 * @param {string|null} file - Stored credential sync file
 * @returns {string|null} Safe private directory cleanup target
 */
export const private_credential_tmpdir = ( file ) => {

    if( !file ) return null

    const directory = dirname( file )
    const is_direct_tmp_child = dirname( directory ) === tmpdir()
    const has_private_prefix = basename( directory ).startsWith( `babysit-creds-` )

    return is_direct_tmp_child && has_private_prefix ? directory : null

}

/**
 * Build a fresh world-writable tmpdir containing chmod-666 files.
 * Use this when an agent needs a whole writable config directory mounted, but
 * Babysit still has to seed more than one file inside that directory.
 *
 * @param {string} tag - Short identifier baked into the tmpdir name
 * @param {string} hint - Filename or label hint baked into the tmpdir name
 * @param {Object.<string, string>} files - Map of filename to file content
 * @returns {string|null} Tmpdir path, or null on error
 */
export const build_tmpdir_with_files = ( tag, hint, files ) => {

    try {

        const tmpdir_path = mkdtempSync( join( tmpdir(), `babysit-${ tag }-${ hint }-` ) )
        chmodSync( tmpdir_path, 0o777 )

        Object.entries( files ).forEach( ( [ filename, content ] ) => {
            const tmpfile = join( tmpdir_path, filename )
            writeFileSync( tmpfile, content )
            chmodSync( tmpfile, 0o666 )
        } )

        return tmpdir_path

    } catch ( e ) {
        log.debug( `Failed to build tmpdir (${ hint }): ${ e.message }` )
        return null
    }

}

/**
 * Build a fresh world-writable tmpdir containing one chmod-666 file.
 * Use this for agent state files that are persisted atomically via
 * write-temp-and-rename: a bind-mounted single file can be written in place,
 * but it cannot be replaced by renaming over the mount point.
 *
 * @param {string} tag - Short identifier baked into the tmpdir name
 * @param {string} filename - Filename to create inside the tmpdir
 * @param {string} content - File content to write
 * @returns {string|null} Tmpdir path, or null on error
 */
export const build_tmpdir_with_file = ( tag, filename, content ) => {

    return build_tmpdir_with_files( tag, filename, { [ filename ]: content } )

}

/**
 * Update an existing tmpfile in place (preserving inode for docker bind
 * mounts) and re-assert chmod 666. The chmod is defensive — if some
 * tooling has stripped permissions out from under us, this restores them.
 *
 * @param {string} tmpfile_path - Path to the existing tmpfile
 * @param {string} content - New content to write
 */
export const rewrite_tmpfile = ( tmpfile_path, content ) => {

    writeFileSync( tmpfile_path, content )
    chmodSync( tmpfile_path, 0o666 )

}
