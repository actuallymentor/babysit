/**
 * OpenAI Codex CLI adapter
 * CLI docs: https://developers.openai.com/codex/cli
 */

/**
 * Resolve the host Codex home. Users can set CODEX_HOME to move Codex's
 * config/auth state; babysit must read host credentials from that location
 * even though it pins the in-container CODEX_HOME separately.
 * @returns {string} Host Codex home path, possibly with a leading ~
 */
export const get_host_codex_home = () => ( process.env.CODEX_HOME || `~/.codex` ).replace( /\/$/, `` )

/**
 * Resolve the host Codex auth file path.
 * @returns {string} Host auth.json path, possibly with a leading ~
 */
export const get_host_codex_auth_file = () => `${ get_host_codex_home() }/auth.json`

export const codex = {

    name: `codex`,
    bin: `codex`,

    credentials: {
        // Codex caches OAuth credentials at `${CODEX_HOME}/auth.json` (the
        // ChatGPT-login flow writes tokens here). API-key users can also set
        // CODEX_API_KEY / OPENAI_API_KEY — try the file first because it is
        // what `codex login` populates by default. The resolver intentionally
        // reads the host's CODEX_HOME; the container CODEX_HOME is pinned
        // separately below.
        darwin: {
            file: get_host_codex_auth_file,
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
        linux: {
            file: get_host_codex_auth_file,
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
    },

    // Pin the codex home dir inside the container so we control exactly where
    // global instructions are read from — and so a stray CODEX_HOME from the
    // host doesn't accidentally redirect codex to a path we never mount.
    // Default container value is the same as codex's own ($HOME/.codex), but
    // declaring it explicitly lets `build_docker_command` set CODEX_HOME=...
    // for the agent and derive `user_globals_file` from the same source.
    home: {
        env_var: `CODEX_HOME`,
        dir: `/home/node/.codex`,
    },

    container_paths: {
        // Mirror `${CODEX_HOME}/auth.json` from host into container so OAuth
        // sessions started with `codex auth login` flow through.
        creds: `/home/node/.codex/auth.json`,
        // Codex's global instructions path: `${CODEX_HOME}/AGENTS.md`.
        // Babysit bind-mounts host `~/.agents/AGENTS.md` here read-only so
        // codex picks up the user's cross-agent globals via its own discovery.
        // The babysit base prompt is delivered separately as
        // config.initial_prompt typed into the tmux pane on launch.
        user_globals_file: `/home/node/.codex/AGENTS.md`,
    },

    flags: {
        // Codex's --yolo (alias for --dangerously-bypass-approvals-and-sandbox) skips
        // both approvals AND its built-in sandbox. We already wrap codex in our own
        // docker sandbox, so the internal one is redundant — and --full-auto would
        // leave the workspace-write sandbox active, blocking real edits in babysit
        // --yolo mode. Use the most permissive flag.
        skip_permissions: () => `--dangerously-bypass-approvals-and-sandbox`,
        // Non-yolo Babysit sessions should still ask for approvals, but Codex's
        // own bubblewrap sandbox cannot create user namespaces inside the
        // unprivileged Docker container. Use Codex's no-sandbox mode while
        // preserving its approval policy.
        bypass_sandbox: () => [ `--sandbox`, `danger-full-access` ],
        // Interactive resume — `codex resume <id>`. The non-interactive form
        // (`codex exec resume`) wouldn't be supervisable through tmux.
        resume: ( id ) => [ `resume`, id ],
        resume_latest: () => [ `resume`, `--last` ],
        model: ( m ) => [ `--model`, m ],
        // Codex reasoning effort lives behind the `model_reasoning_effort` config key
        // (the docs example "reasoning_effort" alone is silently ignored). Pass via -c.
        effort: ( e ) => [ `-c`, `model_reasoning_effort="${ e }"` ],
    },

    defaults: {
        // Latest GA frontier model for coding (April 2026). Falls back to gpt-5.4 for
        // API-key auth without ChatGPT sign-in — users override with --model gpt-5.4.
        model: `gpt-5.5`,
        effort: `xhigh`,
    },

    // Codex prints a ready-to-paste exit hint like:
    // "To continue this session, run codex resume <uuid>". Capture that as
    // well as status-style "Session ID: ..." output; otherwise Babysit falls
    // back to `codex resume --last`, which is inherently less precise.
    session_id_pattern: /(?:codex\s+resume\s+|session(?:\s+id)?[:\s]+)([0-9a-f-]{36})/i,

    // Codex is a full-screen TUI. Wait until it has drawn its first screen
    // before pasting Babysit's launch prompt, otherwise the prompt can land
    // while Codex is still switching terminal modes and render as duplicated
    // or partially submitted text.
    initial_prompt_ready_pattern: /OpenAI Codex/,

    /**
     * Keep Codex's newer SQLite-backed state under CODEX_HOME too. The
     * matching Docker volume is mounted in docker/run.js; the env var covers
     * Codex versions that would otherwise choose a temp sqlite home in some
     * sandbox modes.
     * @returns {Object} Environment variables
     */
    extra_env: () => ( {
        CODEX_SQLITE_HOME: `/home/node/.codex/sqlite`,
    } ),

    // Codex has no documented brew formula and no built-in self-update — the
    // canonical upgrade path per OpenAI's docs is `npm install -g @openai/codex@latest`.
    update: {
        npm_package: `@openai/codex`,
    },

}
