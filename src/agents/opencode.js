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
        // ${OPENCODE_CONFIG_DIR}/AGENTS.md — opencode's global instructions
        // path. Babysit bind-mounts host `~/.agents/AGENTS.md` here so
        // opencode picks up the user's cross-agent globals via its own
        // discovery. Babysit's base prompt is delivered as
        // config.initial_prompt typed into the tmux pane on launch.
        user_globals_file: `/home/node/.config/opencode/AGENTS.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        resume: ( id ) => [ `--session`, id ],
        model: ( m ) => [ `--model`, m ],
        effort: null,
    },

    // gpt-5.5-pro (opencode's built-in default) is rejected by
    // ChatGPT-account auth — see GOTCHAS.md #36. openai/gpt-5.5 works
    // for both OAuth and API-key paths; non-openai providers override
    // via `babysit opencode --model anthropic/claude-opus-4-7`.
    defaults: {
        model: `openai/gpt-5.5`,
    },

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

    update: {
        self_update: { cmd: `opencode`, args: [ `upgrade` ] },
        npm_package: `opencode-ai`,
        brew_package: `opencode`,
    },

}
