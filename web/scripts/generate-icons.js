import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const crc_table = Array.from( { length: 256 }, ( _, number ) => {
    let checksum = number
    Array.from( { length: 8 } ).forEach( () => {
        checksum = checksum & 1 ? 0xedb88320 ^ checksum >>> 1 : checksum >>> 1
    } )
    return checksum >>> 0
} )

const crc32 = buffer => {
    const checksum = buffer.reduce( ( value, byte ) => crc_table[ ( value ^ byte ) & 0xff ] ^ value >>> 8, 0xffffffff ) ^ 0xffffffff
    const result = Buffer.alloc( 4 )
    result.writeUInt32BE( checksum >>> 0 )
    return result
}

const chunk = ( name, data ) => {
    const type = Buffer.from( name )
    const length = Buffer.alloc( 4 )
    length.writeUInt32BE( data.length )
    return Buffer.concat( [ length, type, data, crc32( Buffer.concat( [ type, data ] ) ) ] )
}

const in_rounded_square = ( x, y, size ) => {
    const radius = size * 0.22
    const nearest_x = Math.max( radius, Math.min( size - radius, x ) )
    const nearest_y = Math.max( radius, Math.min( size - radius, y ) )
    return Math.hypot( x - nearest_x, y - nearest_y ) <= radius
}

const pixel_color = ( x, y, size ) => {
    const scale = size / 512
    const in_dot = Math.hypot( x - 408 * scale, y - 104 * scale ) <= 42 * scale
    const in_stem = x >= 143 * scale && x <= 214 * scale && y >= 120 * scale && y <= 440 * scale
    const upper_bowl = Math.pow( ( x - 260 * scale ) / ( 125 * scale ), 2 ) + Math.pow( ( y - 212 * scale ) / ( 92 * scale ), 2 ) <= 1
    const lower_bowl = Math.pow( ( x - 271 * scale ) / ( 138 * scale ), 2 ) + Math.pow( ( y - 345 * scale ) / ( 104 * scale ), 2 ) <= 1
    const inner_upper = Math.pow( ( x - 264 * scale ) / ( 55 * scale ), 2 ) + Math.pow( ( y - 212 * scale ) / ( 33 * scale ), 2 ) <= 1
    const inner_lower = Math.pow( ( x - 276 * scale ) / ( 58 * scale ), 2 ) + Math.pow( ( y - 343 * scale ) / ( 38 * scale ), 2 ) <= 1
    const in_letter = ( in_stem || upper_bowl && !inner_upper || lower_bowl && !inner_lower ) && x <= 401 * scale

    if( !in_rounded_square( x, y, size ) ) return [ 0, 0, 0, 0 ]
    if( in_dot ) return [ 126, 192, 208, 255 ]
    if( in_letter ) return [ 245, 243, 238, 255 ]
    return [ 21, 34, 31, 255 ]
}

const png = size => {
    const rows = Array.from( { length: size }, ( _, y ) => {
        const pixels = Array.from( { length: size }, ( __, x ) => pixel_color( x + 0.5, y + 0.5, size ) ).flat()
        return Buffer.from( [ 0, ...pixels ] )
    } )
    const header = Buffer.alloc( 13 )
    header.writeUInt32BE( size, 0 )
    header.writeUInt32BE( size, 4 )
    header.set( [ 8, 6, 0, 0, 0 ], 8 )

    return Buffer.concat( [
        Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ),
        chunk( `IHDR`, header ),
        chunk( `IDAT`, deflateSync( Buffer.concat( rows ), { level: 9 } ) ),
        chunk( `IEND`, Buffer.alloc( 0 ) ),
    ] )
}

[ 192, 512 ].forEach( size => writeFileSync( resolve( `public/icon-${ size }.png` ), png( size ) ) )
