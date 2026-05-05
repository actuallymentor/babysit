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
        // Claude reads ~/.claude/CLAUDE.md as global context. Babysit
        // bind-mounts host `~/.agents/AGENTS.md` here so claude picks up
        // the user's cross-agent globals via its own discovery. Babysit's
        // base prompt is delivered separately as config.initial_prompt typed
        // into the tmux pane on launch.
        user_globals_file: `/home/node/.claude/CLAUDE.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
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

    // Per-agent update strategies for the host-installed CLI. Tried in order:
    // built-in self-update → npm global install → brew. The runner detects the
    // install method from the binary's resolved path before invoking the
    // package-manager strategies, so an npm-installed agent never accidentally
    // triggers brew (and vice versa).
    update: {
        self_update: { cmd: `claude`, args: [ `update` ] },
        npm_package: `@anthropic-ai/claude-code`,
        // claude on Homebrew is a cask, not a formula — `brew upgrade --cask`
        // is the right invocation. `brew_cask: true` flips the args shape.
        brew_package: `claude-code`,
        brew_cask: true,
    },

}
