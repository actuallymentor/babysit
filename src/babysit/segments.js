import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { log } from '../utils/log.js'

const INITIAL_PROMPT_TOKEN = `%initial_prompt%`

/**
 * Expand dynamic placeholders inside a parsed instruction segment.
 * @param {string} segment - Segment text from a markdown action
 * @param {Object} config - Parsed babysit config section
 * @returns {string} Segment with placeholders resolved
 */
const expand_segment_tokens = ( segment, config = {} ) => {

    const initial_prompt = typeof config.initial_prompt === `string` ? config.initial_prompt : ``
    return segment.split( INITIAL_PROMPT_TOKEN ).join( initial_prompt )

}

/**
 * Expand placeholders and remove segments that became empty.
 * @param {string[]} segments - Parsed instruction segments
 * @param {Object} config - Parsed babysit config section
 * @returns {string[]} Ready-to-send segments
 */
export const expand_segments = ( segments, config = {} ) => {

    return segments
        .map( segment => expand_segment_tokens( segment, config ) )
        .filter( segment => segment.trim().length > 0 )

}

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
 * @param {Object} [options]
 * @param {Object} [options.config] - Parsed babysit config section
 * @returns {string[]|null} Array of segments, or null if file not found
 */
export const load_markdown_segments = ( file_path, {
    config = {},
} = {} ) => {

    const resolved = resolve( process.cwd(), file_path )

    if( !existsSync( resolved ) ) {
        log.warn( `Markdown file not found: ${ resolved }` )
        return null
    }

    const content = readFileSync( resolved, `utf-8` )
    return expand_segments( split_segments( content ), config )

}
