/**
 * OpenAI Codex CLI adapter
 * CLI docs: https://developers.openai.com/codex/cli
 */
export const codex = {

    name: `codex`,
    bin: `codex`,

    credentials: {
        // Codex caches OAuth credentials at `${CODEX_HOME}/auth.json` (the
        // ChatGPT-login flow writes tokens here). API-key users can also set
        // CODEX_API_KEY / OPENAI_API_KEY — try the file first because it is
        // what `codex auth login` populates by default.
        darwin: {
            file: `~/.codex/auth.json`,
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
        linux: {
            file: `~/.codex/auth.json`,
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
    },

    // Pin the codex home dir inside the container so we control exactly where
    // global instructions are read from — and so a stray CODEX_HOME from the
    // host doesn't accidentally redirect codex to a path we never mount.
    // Default container value is the same as codex's own ($HOME/.codex), but
    // declaring it explicitly lets `build_docker_command` set CODEX_HOME=...
    // for the agent and derive `system_prompt_file` from the same source.
    home: {
        env_var: `CODEX_HOME`,
        dir: `/home/node/.codex`,
    },

    container_paths: {
        // Mirror `${CODEX_HOME}/auth.json` from host into container so OAuth
        // sessions started with `codex auth login` flow through.
        creds: `/home/node/.codex/auth.json`,
        // Codex global instructions live at `${CODEX_HOME}/AGENTS.md`
        // (or AGENTS.override.md, but plain AGENTS.md is the canonical name).
        // The older `instructions.md` form is no longer honored — using it
        // here previously meant babysit's system prompt was silently ignored.
        // Path is container-local so it stays writable in mudbox / sandbox too.
        system_prompt_file: `/home/node/.codex/AGENTS.md`,
    },

    flags: {
        // Codex's --yolo (alias for --dangerously-bypass-approvals-and-sandbox) skips
        // both approvals AND its built-in sandbox. We already wrap codex in our own
        // docker sandbox, so the internal one is redundant — and --full-auto would
        // leave the workspace-write sandbox active, blocking real edits in babysit
        // --yolo mode. Use the most permissive flag.
        skip_permissions: () => `--dangerously-bypass-approvals-and-sandbox`,
        // Codex has no --append-system-prompt flag — system prompt is injected
        // via the BABYSIT_SYSTEM_PROMPT env var and the entrypoint writes it
        // to ~/.codex/instructions.md before launching the agent.
        append_system_prompt: null,
        // Interactive resume — `codex resume <id>`. The non-interactive form
        // (`codex exec resume`) wouldn't be supervisable through tmux.
        resume: ( id ) => [ `resume`, id ],
        model: ( m ) => [ `--model`, m ],
        // Codex reasoning effort lives behind the `model_reasoning_effort` config key
        // (the docs example "reasoning_effort" alone is silently ignored). Pass via -c.
        effort: ( e ) => [ `-c`, `model_reasoning_effort="${ e }"` ],
    },

    defaults: {
        // Latest GA frontier model for coding (April 2026). Falls back to gpt-5.4 for
        // API-key auth without ChatGPT sign-in — users override with --model gpt-5.4.
        model: `gpt-5.5`,
        effort: `high`,
    },

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
