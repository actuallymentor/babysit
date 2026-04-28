# Babysit Container — Installed CLI Tools

This container is a sandboxed environment for LLM coding agents, built by [babysit](https://github.com/actuallymentor/babysit).

## Runtimes
- **Node.js 24** (LTS) — `node`, `npm`, `npx`
- **Python 3** — `python3`, `uv` (fast pip replacement)
- **Bun** — if installed via agent

## Coding Agents
- `claude` — Claude Code (Anthropic)
- `codex` — Codex CLI (OpenAI)
- `gemini` — Gemini CLI (Google)
- `opencode` — OpenCode

## CLI Tools
| Tool | Purpose |
|------|---------|
| `git` | Version control |
| `rg` (ripgrep) | Fast recursive search |
| `fd` | Fast file finder |
| `bat` | Syntax-highlighted cat |
| `fzf` | Fuzzy finder |
| `jq` / `yq` | JSON/YAML processing |
| `curl` / `wget` | HTTP requests |
| `tmux` | Terminal multiplexer |
| `htop` | Process monitor |
| `strace` / `lsof` | Debugging |

## Filesystem
- `/workspace` — bind-mounted from host (read-write, read-only, or empty depending on mode)
- `~/.agents` — host agent configs (read-only)
- `~/AGENTS.md` — this file

## Permissions
- Passwordless `sudo` for any root operation
- Git identity configured via environment variables
