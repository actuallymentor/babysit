import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const PROMPT_DIR = join( __dirname, `..`, `system_prompt` )

/**
 * Read a system prompt fragment from disk
 * @param {string} name - Fragment name (base, yolo, sandbox, mudbox)
 * @returns {string} File contents
 */
const read_fragment = ( name ) => readFileSync( join( PROMPT_DIR, `${ name }.md` ), `utf-8` ).trim()

/**
 * Build the full system prompt based on active mode flags
 * @param {Object} mode - { yolo, sandbox, mudbox }
 * @returns {string} Combined system prompt
 */
export const build_system_prompt = ( mode ) => {

    const parts = [ read_fragment( `base` ) ]

    if( mode.sandbox ) parts.push( read_fragment( `sandbox` ) )
    if( mode.mudbox ) parts.push( read_fragment( `mudbox` ) )
    if( mode.yolo ) parts.push( read_fragment( `yolo` ) )

    return parts.join( `\n\n` )

}
