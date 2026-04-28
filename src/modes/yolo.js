/**
 * Apply yolo mode settings
 * @param {Object} context - { agent, docker_env, system_prompt_parts }
 */
export const apply_yolo = ( context ) => {

    context.mode.yolo = true
    context.docker_env.AGENT_AUTONOMY_MODE = `yolo`

}
