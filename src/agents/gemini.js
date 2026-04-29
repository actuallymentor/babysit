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
        // Container-local path so it's writable in mudbox / sandbox too.
        // Gemini reads ~/.gemini/GEMINI.md as global context in addition to any
        // GEMINI.md in the workspace.
        system_prompt_file: `/home/node/.gemini/GEMINI.md`,
    },

    flags: {
        skip_permissions: () => `--yolo`,
        // Gemini doesn't expose a CLI flag for system prompts — it reads
        // GEMINI.md from the workspace. Handled via entrypoint + env var.
        append_system_prompt: null,
        resume: ( id ) => [ `--resume`, id ],
        model: ( m ) => [ `--model`, m ],
        // Gemini has no effort/reasoning knob.
        effort: null,
    },

    defaults: {
        // `gemini-pro-latest` is Google's official alias for the most capable Gemini
        // available — it currently resolves to gemini-3.1-pro and rolls forward
        // automatically when newer Pro models ship.
        model: `gemini-pro-latest`,
    },

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
