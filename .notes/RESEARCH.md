# Agent CLI Research

Last verified against vendor docs: April 2026.

## Claude Code
- **Binary**: `claude`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `--append-system-prompt "text"` (preferred — preserves built-in capabilities). `--system-prompt "text"` replaces the entire prompt.
- **Resume**: `claude --resume <id>` or `claude -r <id>`
- **Model**: `--model opus` / `--model sonnet` (aliases roll forward; opus → claude-opus-4-7 as of 2026-04-23)
- **Effort**: `--effort max` (other levels: low, medium, high, xhigh; available levels depend on the model)
- **Creds**: `~/.claude/.credentials.json` (linux), Keychain service "Claude Code-credentials" (macOS)
- **Install location**: `~/.local/bin/claude` (binary lives under `~/.local/share/claude/versions/` with a symlink in `~/.local/bin`). Container Dockerfile must add `~/.local/bin` to PATH.

## Codex
- **Binary**: `codex`
- **Skip perms**: `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`). `--full-auto` only skips approvals — it leaves codex's `workspace-write` sandbox active, which blocks real edits inside our docker container.
- **System prompt**: no CLI flag — uses `AGENTS.md` in workspace (or `~/.codex/instructions.md`). Babysit injects via entrypoint (env → file).
- **Resume**: `codex resume <id>` for interactive (what we use), `codex exec resume <id>` for non-interactive
- **Model**: `--model gpt-5.5` (as of April 2026; `gpt-5.4` is the API-key fallback if 5.5 isn't accessible)
- **Effort**: `-c model_reasoning_effort="high"` (NOT bare `reasoning_effort` — that key is silently ignored). Values: `minimal`, `low`, `medium`, `high`, `xhigh` (xhigh requires 5.1-codex-max / 5.2-codex)
- **Creds**: `CODEX_API_KEY` or `OPENAI_API_KEY` env var

## Gemini CLI
- **Binary**: `gemini`
- **Skip perms**: `--yolo` or `--approval-mode=yolo`
- **System prompt**: context file `GEMINI.md` (project-local). Babysit appends to `~/.gemini/GEMINI.md` via entrypoint.
- **Resume**: `gemini --resume latest` or `--resume <uuid>` or `--resume <session_index>`
- **Model**: `--model gemini-pro-latest` (alias resolves to gemini-3.1-pro as of March 2026; rolls forward automatically)
- **Effort**: no equivalent
- **Creds**: `GEMINI_API_KEY` env var or OAuth

## OpenCode
- **Binary**: `opencode`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `AGENTS.md` (project-local). Babysit appends via entrypoint.
- **Resume**: `opencode --session <id>` (or `-c` for continue)
- **Model**: `--model provider/model` — depends on user's auth.json provider, no sensible default to inject
- **Creds**: `~/.local/share/opencode/auth.json`
- **Install location**: `~/.local/bin/opencode` (curl install) or `~/.opencode/bin/opencode` (alternate). Container Dockerfile puts both on PATH.
