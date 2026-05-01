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
| `git` / `gh` | Version control + GitHub PRs/issues |
| `rg` (ripgrep) | Fast recursive search |
| `fd` | Fast file finder |
| `bat` | Syntax-highlighted cat |
| `fzf` | Fuzzy finder |
| `jq` / `yq` | JSON/YAML processing |
| `curl` / `wget` | HTTP requests |
| `tmux` | Terminal multiplexer |
| `tree` / `less` | Directory listing + paging |
| `sqlite3` | SQLite database CLI |
| `shellcheck` | Shell script linter |
| `scc` | Fast lines-of-code counter |
| `htop` | Process monitor |
| `strace` / `lsof` | Debugging |

## Filesystem
- `/workspace` — bind-mounted from host (read-write, read-only, or empty depending on mode)
- `~/.agents` — host agent configs (read-write, bind-mounted)
- `~/AGENTS.md` — this file

## Permissions
- Passwordless `sudo` for any root operation
- Git identity configured via environment variables
