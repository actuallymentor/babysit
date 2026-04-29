/**
 * OpenAI Codex CLI adapter
 * CLI docs: https://developers.openai.com/codex/cli
 */
export const codex = {

    name: `codex`,
    bin: `codex`,

    credentials: {
        darwin: {
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
        linux: {
            env_key: `CODEX_API_KEY`,
            fallback_env: `OPENAI_API_KEY`,
        },
    },

    container_paths: {
        creds: null,
        // Container-local instructions path — writable in every mode (sandbox empties
        // /workspace; mudbox makes it read-only). Codex picks this up as global
        // context in addition to any AGENTS.md the user keeps in their workspace.
        system_prompt_file: `/home/node/.codex/instructions.md`,
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
