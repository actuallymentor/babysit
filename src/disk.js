import { spawn } from 'child_process'
import { existsSync, statSync, statfsSync } from 'fs'
import { homedir } from 'os'

// statfs `type` for ZFS, which frees deleted blocks in the background
const ZFS_MAGIC = 0x2fc12fc1

/**
 * Human size in decimal units, matching `df -H` and Docker's own output.
 * @param {number} bytes - Size
 * @returns {string} `38 GB`, `1.2 GB`, `512 MB`, or `unknown`
 */
export const format_bytes = bytes => {

    if( !Number.isFinite( bytes ) ) return `unknown`

    const units = [ `B`, `kB`, `MB`, `GB`, `TB`, `PB` ]
    let value = Math.max( 0, bytes )
    let index = 0

    while( value >= 1_000 && index < units.length - 1 ) {
        value /= 1_000
        index++
    }

    const digits = index && value < 10 ? 1 : 0
    return `${ value.toFixed( digits ) } ${ units[ index ] }`

}

/**
 * Display a path with the home directory folded to `~`.
 * @param {string} path - Absolute path
 * @returns {string}
 */
export const tilde = path => {

    const home = homedir()
    return path === home || path.startsWith( `${ home }/` ) ? `~${ path.slice( home.length ) }` : path

}

/**
 * The filesystem holding a path, or null when the path cannot be read here
 * (not created yet, a daemon in a VM, or a host path seen from inside a nested session).
 * @param {string} path - Any path on the filesystem
 * @param {Object} [seams]
 * @returns {{ dev: number, total_bytes: number, free_bytes: number, zfs: boolean }|null}
 */
export const filesystem_of = ( path, { stat = statSync, statfs = statfsSync } = {} ) => {

    if( typeof path !== `string` || !path ) return null

    try {
        const { dev } = stat( path )
        const { bsize, blocks, bavail, type } = statfs( path )
        return { dev, total_bytes: blocks * bsize, free_bytes: bavail * bsize, zfs: type === ZFS_MAGIC }
    } catch {
        return null
    }

}

/**
 * Group labelled storage parts by the filesystem they live on.
 * Parts whose path cannot be read are left out.
 * @param {Array<{ path: string, label: string, bytes?: number }>} parts
 * @param {Object} [seams] - Passed to filesystem_of
 * @returns {Array<Object>} `{ path, dev, total_bytes, free_bytes, zfs, parts }` per filesystem
 */
export const group_by_filesystem = ( parts, seams ) => {

    const groups = new Map()

    for( const part of parts ) {
        const filesystem = filesystem_of( part.path, seams )
        if( !filesystem ) continue

        const group = groups.get( filesystem.dev ) || { path: part.path, ...filesystem, parts: [] }
        group.parts.push( part )
        groups.set( filesystem.dev, group )
    }

    return [ ...groups.values() ]

}

/**
 * Disk space a directory tree consumes, via `du` so huge trees never block
 * the event loop. Unreadable subtrees (root-owned files) make `du` exit
 * non-zero but it still prints a total: that lower bound is returned.
 * @param {string} path - Directory
 * @param {Object} [options]
 * @param {number} [options.timeout_ms] - Wall-clock bound
 * @returns {Promise<number|null>} Bytes, 0 for a missing path, null when unmeasurable
 */
export const directory_bytes = ( path, { timeout_ms = 10 * 60_000 } = {} ) => {

    if( !existsSync( path ) ) return Promise.resolve( 0 )

    return new Promise( resolve => {

        // -x stays on this filesystem; -k is portable between GNU and BSD du
        const child = spawn( `du`, [ `-skx`, path ], { stdio: [ `ignore`, `pipe`, `ignore` ] } )
        const timer = setTimeout( () => child.kill( `SIGKILL` ), timeout_ms )
        timer.unref?.()
        let stdout = ``

        child.stdout.on( `data`, chunk => stdout += chunk )
        child.on( `error`, () => resolve( null ) )
        child.on( `close`, () => {
            clearTimeout( timer )
            const [ , kilobytes ] = stdout.match( /^(\d+)\s/m ) || []
            resolve( kilobytes ? Number( kilobytes ) * 1_024 : null )
        } )

    } )

}
