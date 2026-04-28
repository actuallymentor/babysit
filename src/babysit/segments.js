import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../utils/log.js'

/**
 * Split a string or markdown file content into segments separated by === lines.
 * Each segment is an instruction to send, and === means "wait for idle before continuing."
 * @param {string} content - Raw content (string or file contents)
 * @returns {string[]} Array of segments to execute in sequence
 */
export const split_segments = ( content ) => {

    return content
        .split( /^={3,}$/m )
        .map( s => s.trim() )
        .filter( s => s.length > 0 )

}

/**
 * Load a markdown file and split it into segments.
 * Resolves relative paths against the current working directory.
 * @param {string} file_path - Path to the markdown file
 * @returns {string[]|null} Array of segments, or null if file not found
 */
export const load_markdown_segments = ( file_path ) => {

    const resolved = resolve( process.cwd(), file_path )

    if( !existsSync( resolved ) ) {
        log.warn( `Markdown file not found: ${ resolved }` )
        return null
    }

    const content = readFileSync( resolved, `utf-8` )
    return split_segments( content )

}
