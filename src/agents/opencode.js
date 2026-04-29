/**
 * OpenCode adapter
 * CLI docs: https://opencode.ai/docs/cli/
 */
export const opencode = {

    name: `opencode`,
    bin: `opencode`,

    credentials: {
        darwin: {
            file: `~/.local/share/opencode/auth.json`,
        },
        linux: {
            file: `~/.local/share/opencode/auth.json`,
        },
    },

    // OPENCODE_CONFIG_DIR points at the config dir directly (it does NOT
    // append `.opencode` or similar). Pin to the same XDG-style location
    // opencode would pick up by default, so the global AGENTS.md and any
    // user-supplied agents/commands/modes/plugins all resolve from the
    // same root.
    home: {
        env_var: `OPENCODE_CONFIG_DIR`,
        dir: `/home/node/.config/opencode`,
    },

    container_paths: {
        creds: `/home/node/.local/share/opencode/auth.json`,
        // ${OPENCODE_CONFIG_DIR}/AGENTS.md — container-local so it remains
        // writable in mudbox / sandbox modes too.
        system_prompt_file: `/home/node/.config/opencode/AGENTS.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        // OpenCode picks up system instructions from AGENTS.md / config files.
        // The entrypoint writes BABYSIT_SYSTEM_PROMPT into the right path.
        append_system_prompt: null,
        resume: ( id ) => [ `--session`, id ],
        model: ( m ) => [ `--model`, m ],
        effort: null,
    },

    // OpenCode runs whatever model the user has authenticated with — no default
    // override here so the user's own provider/model selection wins.
    defaults: {},

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
