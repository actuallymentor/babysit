import { base, yolo, sandbox, mudbox, docker_mode, host_agent_context_ignored } from '../system_prompt/index.js'

/**
 * Build the full system prompt based on active mode flags
 * @param {Object} mode - { yolo, sandbox, mudbox, docker, ignore_host_agents_md }
 * @returns {string} Combined system prompt
 */
export const build_system_prompt = ( mode ) => {

    const parts = [ base ]

    if( mode.sandbox ) parts.push( sandbox )
    if( mode.mudbox ) parts.push( mudbox )
    if( mode.docker ) parts.push( docker_mode )
    if( mode.ignore_host_agents_md ) parts.push( host_agent_context_ignored )
    if( mode.yolo ) parts.push( yolo )

    return parts.join( `\n\n` )

}
