import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

// Minimal ustar writer. `docker cp <file> CONTAINER:<path>` into a stopped
// container costs seconds per call on busy daemons (each upload mounts the
// container rootfs); `docker cp - CONTAINER:/` with one tar costs one mount.

const BLOCK = 512

const octal = ( value, width ) => `${ value.toString( 8 ).padStart( width - 1, `0` ) }\0`

/** Split a path into ustar prefix/name fields when it exceeds 100 bytes. */
const split_name = path => {

    if( Buffer.byteLength( path ) <= 100 ) return { prefix: ``, name: path }

    // Prefix takes as many leading segments as fit; name keeps the rest.
    const cut = path.lastIndexOf( `/`, 155 )
    const prefix = path.slice( 0, cut )
    const name = path.slice( cut + 1 )
    if( cut < 1 || Buffer.byteLength( name ) > 100 ) {
        throw new Error( `Tar entry path too long: ${ path }` )
    }

    return { prefix, name }

}

const header_for = ( { path, mode, size, type, mtime } ) => {

    const header = Buffer.alloc( BLOCK )
    const { prefix, name } = split_name( path )

    header.write( name, 0, 100 )
    header.write( octal( mode & 0o7777, 8 ), 100 )
    header.write( octal( 0, 8 ), 108 ) // uid root, like `docker cp`
    header.write( octal( 0, 8 ), 116 ) // gid root
    header.write( octal( size, 12 ), 124 )
    header.write( octal( mtime, 12 ), 136 )
    header.write( `        `, 148 ) // checksum placeholder
    header.write( type, 156 )
    header.write( `ustar\0`, 257 )
    header.write( `00`, 263 )
    header.write( `root`, 265 )
    header.write( `root`, 297 )
    header.write( prefix, 345, 155 )

    const checksum = header.reduce( ( sum, byte ) => sum + byte, 0 )
    header.write( `${ checksum.toString( 8 ).padStart( 6, `0` ) }\0 `, 148 )

    return header

}

const pad_to_block = size => ( BLOCK - size % BLOCK ) % BLOCK

const strip_slashes = path => path.replace( /^\/+|\/+$/g, `` )

/** Walk one host path into tar entries rooted at `target` (absolute container path). */
const entries_for = ( source, target ) => {

    const stats = statSync( source )
    const path = strip_slashes( target )
    const mtime = Math.floor( stats.mtimeMs / 1_000 )

    if( stats.isDirectory() ) return [
        { path: `${ path }/`, mode: stats.mode, size: 0, type: `5`, mtime, content: Buffer.alloc( 0 ) },
        ...children_for( source, path ),
    ]

    if( !stats.isFile() ) throw new Error( `Unsupported tar source: ${ source }` )

    const content = readFileSync( source )
    return [ { path, mode: stats.mode, size: content.length, type: `0`, mtime, content } ]

}

/** Entries for a directory's contents, placed directly under `target`. */
const children_for = ( directory, target ) => readdirSync( directory )
    .sort()
    .flatMap( child => entries_for( join( directory, child ), `${ target }/${ child }` ) )

/**
 * Build one ustar archive from host paths, each placed at its container path.
 * A directory source ending in `/.` contributes its contents (docker cp
 * semantics); a plain directory is recreated under target.
 *
 * @param {Array<{ source: string, target: string }>} mounts - Host sources and absolute container targets
 * @returns {Buffer} Tar archive ready for `docker cp - CONTAINER:/`
 */
export const build_tar_archive = ( mounts = [] ) => {

    // `dir/.` copies the directory's contents (docker cp semantics)
    const entries = mounts.flatMap( ( { source, target } ) => source.endsWith( `/.` )
        ? children_for( source.slice( 0, -2 ), strip_slashes( target ) )
        : entries_for( source, target )
    )

    const blocks = entries.flatMap( entry => [
        header_for( entry ),
        entry.content,
        Buffer.alloc( pad_to_block( entry.size ) ),
    ] )

    return Buffer.concat( [ ...blocks, Buffer.alloc( BLOCK * 2 ) ] )

}
