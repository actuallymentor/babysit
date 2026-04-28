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
        skip_permissions: () => `--full-auto`,
        // Codex has no --append-system-prompt flag — system prompt is injected
        // via the BABYSIT_SYSTEM_PROMPT env var and the entrypoint writes it
        // to ~/.codex/instructions.md before launching the agent.
        append_system_prompt: null,
        // Interactive resume — `codex resume <id>`. The non-interactive form
        // (`codex exec resume`) wouldn't be supervisable through tmux.
        resume: ( id ) => [ `resume`, id ],
        model: ( m ) => [ `--model`, m ],
        // Codex reasoning effort is exposed via the `-c` config override.
        effort: ( e ) => [ `-c`, `reasoning_effort=${ e }` ],
    },

    defaults: {
        model: `gpt-5-codex`,
        effort: `high`,
    },

    session_id_pattern: /session[:\s]+([0-9a-f-]{36})/i,

    extra_env: () => ( {} ),

}
