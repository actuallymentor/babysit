/**
 * Gemini CLI adapter
 * CLI docs: https://github.com/google-gemini/gemini-cli
 */
export const gemini = {

    name: `gemini`,
    bin: `gemini`,

    credentials: {
        // Gemini's `auth login` flow caches OAuth tokens at
        // `~/.gemini/oauth_creds.json`. API-key users get GEMINI_API_KEY via
        // env. Try the file first since it's what the OAuth flow writes by
        // default; the env path stays available as a fallback / override.
        darwin: {
            file: `~/.gemini/oauth_creds.json`,
            env_key: `GEMINI_API_KEY`,
        },
        linux: {
            file: `~/.gemini/oauth_creds.json`,
            env_key: `GEMINI_API_KEY`,
        },
    },

    // GEMINI_CLI_HOME points at the *parent* directory; gemini creates a
    // `.gemini/` folder inside it. Pin it to /home/node so the global
    // GEMINI.md lives at /home/node/.gemini/GEMINI.md inside the container.
    home: {
        env_var: `GEMINI_CLI_HOME`,
        dir: `/home/node`,
    },

    container_paths: {
        // Bind-mount oauth_creds.json into the container so OAuth sessions
        // started on the host flow through. Path matches gemini's own default.
        creds: `/home/node/.gemini/oauth_creds.json`,
        // ${GEMINI_CLI_HOME}/.gemini/GEMINI.md — container-local so it stays
        // writable in mudbox / sandbox too. Gemini reads this as global
        // context in addition to any GEMINI.md the user keeps in /workspace.
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

    // Outside yolo, trustedFolders.json is the source of truth — don't
    // override it with --skip-trust.
    extra_args: ( mode ) => mode?.yolo ? [ `--skip-trust` ] : [],

    // Don't force a model. Gemini's internal "agent router" picks the best
    // available model for the user's plan; forcing `gemini-pro-latest` here
    // breaks for users on Code Assist for Individuals (the free tier),
    // because Pro routing was restricted to paid plans. Letting the user's
    // own plan select the model is more portable than guessing.
    defaults: {},

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
