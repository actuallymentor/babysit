/**
 * Gemini CLI adapter
 * CLI docs: https://github.com/google-gemini/gemini-cli
 */
export const gemini = {

    name: `gemini`,
    bin: `gemini`,

    credentials: {
        darwin: {
            env_key: `GEMINI_API_KEY`,
        },
        linux: {
            env_key: `GEMINI_API_KEY`,
        },
    },

    container_paths: {
        creds: null,
    },

    flags: {
        skip_permissions: () => `--yolo`,
        append_system_prompt: null,
        resume: ( id ) => [ `--resume`, id ],
        model: ( m ) => [ `--model`, m ],
        effort: null,
    },

    defaults: {
        model: `gemini-2.5-pro`,
    },

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
