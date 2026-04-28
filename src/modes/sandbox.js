/**
 * Apply sandbox mode settings
 * @param {Object} context - { agent, docker_env, system_prompt_parts }
 */
export const apply_sandbox = ( context ) => {

    context.mode.sandbox = true
    context.docker_env.AGENT_AUTONOMY_MODE = `sandbox`

}
