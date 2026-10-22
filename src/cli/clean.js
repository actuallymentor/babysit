import { readFileSync, renameSync, writeFileSync } from 'fs'
import { relative } from 'path'
import { isDeepStrictEqual } from 'util'
import { parseDocument, visit } from 'yaml'

import { paint } from '../utils/color.js'
import { audit_targets } from './audit.js'

/**
 * Strip full-line comments and blank lines from yaml, keeping inline comments.
 * Lines inside multi-line scalars (`|`, `>`, quoted, plain) are content, so they
 * are never touched. The result must parse to the same values as the input.
 * @param {string} text - Yaml source
 * @returns {{ text: string, comments: number, blanks: number }} Cleaned source and what was dropped
 * @throws When the yaml is invalid, or cleaning would change its values
 */
export const clean_yaml = text => {

    const doc = parseDocument( text )
    if( doc.errors.length ) throw new Error( doc.errors[0].message.split( `\n` )[0] )

    const eol = text.includes( `\r\n` ) ? `\r\n` : `\n`
    const lines = text.split( /\r?\n/ )

    // The empty piece after a final newline is no blank line
    if( lines.at( -1 ) === `` ) lines.pop()

    // Offset of each line start, to map scalar ranges onto lines
    const starts = []
    let offset = 0
    for( const line of lines ) {
        starts.push( offset )
        offset += line.length + eol.length
    }
    const line_of = position => starts.findLastIndex( start => start <= position )

    // Every line after the first of a multi-line scalar is part of its value
    const protect = new Set()
    visit( doc, {
        Scalar: ( _, node ) => {
            if( !node.range ) return
            const first = line_of( node.range[0] )
            const last = line_of( Math.max( node.range[0], node.range[1] - 1 ) )
            for( let index = first + 1; index <= last; index++ ) protect.add( index )
        },
    } )

    let comments = 0
    let blanks = 0
    const kept = lines.filter( ( line, index ) => {
        if( protect.has( index ) ) return true
        if( !line.trim() ) return blanks++, false
        if( line.trimStart().startsWith( `#` ) ) return comments++, false
        return true
    } )

    const cleaned = kept.length ? `${ kept.join( eol ) }${ eol }` : ``

    // Never trade values for tidiness: a block scalar edge case must fail loudly
    const again = parseDocument( cleaned )
    if( again.errors.length || !isDeepStrictEqual( again.toJS(), doc.toJS() ) ) throw new Error( `cleaning would change the values; left as it was` )

    return { text: cleaned, comments, blanks }

}

/**
 * `babysit clean --config FILE|DIR/`: remove full-line comments and blank lines
 * from configuration yaml in place, keeping inline comments.
 * @param {Object} [command] - Parsed command
 * @param {Object} [seams] - IO for tests
 * @returns {Promise<number>} Exit code: 1 when any file could not be cleaned
 */
export const cmd_clean = async ( { flags = {} } = {}, { print = console.log, write = writeFileSync } = {} ) => {

    if( !flags.config ) throw new Error( `babysit clean needs --config FILE or --config DIR/` )

    const { base, files } = audit_targets( flags.config )
    if( !files.length ) throw new Error( `No .yaml or .yml files in ${ flags.config }` )

    let failed = 0
    for( const path of files ) {

        const file = relative( base, path ) || path
        try {
            const before = readFileSync( path, `utf8` )
            const { text, comments, blanks } = clean_yaml( before )

            if( text === before ) {
                print( `${ file }: already clean` )
                continue
            }

            // Temp file + rename: an interrupted write never leaves half a config
            if( !flags.dry_run ) {
                write( `${ path }.clean.tmp`, text )
                renameSync( `${ path }.clean.tmp`, path )
            }
            print( `${ file }: ${ flags.dry_run ? `would remove` : `removed` } ${ comments } comment line${ comments === 1 ? `` : `s` }, ${ blanks } blank line${ blanks === 1 ? `` : `s` }` )

        } catch ( error ) {
            failed++
            print( paint( `${ file }: ${ error.message }`, `red` ) )
        }

    }

    return failed ? 1 : 0

}
