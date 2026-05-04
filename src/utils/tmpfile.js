import { existsSync, readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, basename } from 'path'

import { log } from './log.js'

// Why every tmpfile we bind into the container needs an explicit chmod 666:
// Node's `fs.writeFileSync(path, data, { mode: 0o666 })` is masked by the
// host user's umask (typically 0o022 → 0o644 or 0o002 → 0o664). The
// container runs as `node` (uid 1000); the host file is owned by whatever
// the host user is (uid 1001 in our case). `node` matches neither the
// owner nor any of the file's groups, so it lands in "other" — and "other"
// has no write bit when the file is 0o664. Several agents (claude,
// codex, gemini) update their state file in place during init; that
// silent EACCES leaves the TUI hanging mid-render. See
// .notes/GOTCHAS.md gotcha #29 for the full story.

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

    try {

        const tmpdir_path = mkdtempSync( join( tmpdir(), `babysit-${ tag }-${ filename }-` ) )
        chmodSync( tmpdir_path, 0o777 )

        const tmpfile = join( tmpdir_path, filename )
        writeFileSync( tmpfile, content )
        chmodSync( tmpfile, 0o666 )

        return tmpdir_path

    } catch ( e ) {
        log.debug( `Failed to build tmpdir (${ filename }): ${ e.message }` )
        return null
    }

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
