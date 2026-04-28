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

    container_paths: {
        creds: `/home/node/.local/share/opencode/auth.json`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        append_system_prompt: null,
        resume: ( id ) => [ `--session`, id ],
        model: ( m ) => [ `--model`, m ],
        effort: null,
    },

    defaults: {},

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
