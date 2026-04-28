/**
 * OpenAI Codex CLI adapter
 * CLI docs: https://developers.openai.com/codex/cli
 */
export const codex = {

    name: `codex`,
    bin: `codex`,

    credentials: {
        darwin: {
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
        linux: {
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
    },

    container_paths: {
        creds: null,
    },

    flags: {
        skip_permissions: () => `--full-auto`,
        append_system_prompt: null,
        resume: ( id ) => [ `exec`, `resume`, `--last` ],
        model: null,
        effort: null,
    },

    defaults: {},

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
