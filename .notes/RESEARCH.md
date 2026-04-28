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
- **System prompt**: needs verification — likely config file
- **Resume**: `codex exec resume --last`
- **Model**: needs verification
- **Creds**: needs verification

## Gemini CLI
- **Binary**: `gemini`
- **Skip perms**: `--yolo` or `--approval-mode=yolo`
- **System prompt**: context file `GEMINI.md` (project + global `~/.gemini/GEMINI.md`)
- **Resume**: `gemini --resume latest` or `--resume <uuid>`
- **Model**: `-m gemini-2.5-flash` or `--model auto`
- **Creds**: `GEMINI_API_KEY` env var or OAuth

## OpenCode
- **Binary**: `opencode`
- **Skip perms**: `--dangerously-skip-permissions`
- **System prompt**: needs verification
- **Resume**: `opencode --session <id>` or `-c` for continue
- **Model**: `--model provider/model`
- **Creds**: `~/.local/share/opencode/auth.json`
