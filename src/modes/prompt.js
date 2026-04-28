import { base, yolo, sandbox, mudbox } from '../system_prompt/index.js'

/**
 * Build the full system prompt based on active mode flags
 * @param {Object} mode - { yolo, sandbox, mudbox }
 * @returns {string} Combined system prompt
 */
export const build_system_prompt = ( mode ) => {

    const parts = [ base ]

    if( mode.sandbox ) parts.push( sandbox )
    if( mode.mudbox ) parts.push( mudbox )
    if( mode.yolo ) parts.push( yolo )

    return parts.join( `\n\n` )

}
