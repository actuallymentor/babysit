# Agent CLI Research

## Claude Code
- **Binary**: `claude`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `--append-system-prompt "text"` or `--system-prompt "text"`
- **Resume**: `claude --resume <id>` or `claude -r <id>`
- **Model**: `--model opus` / `--model sonnet`
- **Effort**: `--effort max`
- **Creds**: `~/.claude/.credentials.json` (linux), Keychain service "Claude Code-credentials" (macOS)

## Codex
- **Binary**: `codex`
- **Skip perms**: `--full-auto` or `--dangerously-bypass-approvals-and-sandbox`
- **System prompt**: no CLI flag — uses `AGENTS.md` in workspace (or `~/.codex/instructions.md`). Babysit injects via entrypoint (env → file).
- **Resume**: `codex resume <id>` for interactive (what we use), `codex exec resume <id>` for non-interactive
- **Model**: `--model gpt-5-codex` (current latest)
- **Effort**: `-c reasoning_effort=high` (config override)
- **Creds**: `CODEX_API_KEY` or `OPENAI_API_KEY` env var

## Gemini CLI
- **Binary**: `gemini`
- **Skip perms**: `--yolo` or `--approval-mode=yolo`
- **System prompt**: context file `GEMINI.md` (project-local). Babysit appends to `/workspace/GEMINI.md` via entrypoint.
- **Resume**: `gemini --resume latest` or `--resume <uuid>`
- **Model**: `--model gemini-2.5-pro` (current most-capable)
- **Effort**: no equivalent
- **Creds**: `GEMINI_API_KEY` env var or OAuth

## OpenCode
- **Binary**: `opencode`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: `AGENTS.md` (project-local). Babysit appends via entrypoint.
- **Resume**: `opencode --session <id>` (or `-c` for continue)
- **Model**: `--model provider/model` — depends on user's auth.json provider, no sensible default to inject
- **Creds**: `~/.local/share/opencode/auth.json`
