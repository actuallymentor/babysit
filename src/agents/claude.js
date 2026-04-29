/**
 * Claude Code adapter
 * CLI docs: https://code.claude.com/docs/en/cli-reference
 */
export const claude = {

    name: `claude`,
    bin: `claude`,

    credentials: {
        darwin: {
            keychain_service: `Claude Code-credentials`,
            fallback_file: `~/.claude/.credentials.json`,
        },
        linux: {
            file: `~/.claude/.credentials.json`,
        },
    },

    // CLAUDE_CONFIG_DIR controls where claude reads its config / credentials /
    // sessions from. We already mount our host-derived state under
    // /home/node/.claude inside the container, so pin the env var to that
    // path — this also prevents a stray host CLAUDE_CONFIG_DIR from leaking
    // through and redirecting claude to an unmounted location.
    home: {
        env_var: `CLAUDE_CONFIG_DIR`,
        dir: `/home/node/.claude`,
    },

    container_paths: {
        creds: `/home/node/.claude/.credentials.json`,
        config: `/home/node/.claude/settings.json`,
        // Claude takes the system prompt as a CLI flag, so this hint is unused —
        // included for shape consistency with the other adapters.
        system_prompt_file: null,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        append_system_prompt: ( text ) => [ `--append-system-prompt`, text ],
        system_prompt: ( text ) => [ `--system-prompt`, text ],
        resume: ( id ) => [ `--resume`, id ],
        model: ( m ) => [ `--model`, m ],
        effort: ( e ) => [ `--effort`, e ],
    },

    defaults: {
        model: `opus`,
        effort: `max`,
    },

    // Pattern to capture the session ID from claude's output
    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    /**
     * Get extra environment variables for this agent
     * @returns {Object} Environment variables
     */
    extra_env: () => ( {
        DISABLE_AUTOUPDATER: `1`,
    } ),

}
