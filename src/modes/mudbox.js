/**
 * Apply mudbox mode settings
 * @param {Object} context - { agent, docker_env, system_prompt_parts }
 */
export const apply_mudbox = ( context ) => {

    context.mode.mudbox = true
    context.docker_env.AGENT_AUTONOMY_MODE = `mudbox`

}
