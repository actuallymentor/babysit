# Changelog

## 0.1.0 — 2026-04-28

### ✨ Initial release

- **Multi-agent support** — Claude, Codex, Gemini, and opencode behind a unified adapter interface
- **Declarative supervision** — `babysit.yaml` with `on/do` rules: idle, plan, choice, literal string, and regex triggers
- **Docker isolation** — single container image with all four agent CLIs, passwordless sudo, and common dev tools
- **Tmux sessions** — detachable sessions with history, mouse support, and named sockets
- **Mode flags** — `--yolo`, `--sandbox`, `--mudbox`, `--loop` with combinable behavior
- **Credential passthrough** — platform-specific (macOS Keychain / Linux file) with background sync daemon
- **Dependency isolation** — hash-based Docker volumes for `node_modules` and `.venv`
- **Session management** — `babysit list`, `babysit open`, `babysit resume`
- **Self-update** — preflight `git pull` + `docker pull` on every command
- **Segment execution** — `===`-delimited markdown files with idle-wait between segments
- **Statusline** — Claude Code statusline showing modifiers, repo, branch, and loop countdown
- **Cross-platform binaries** — bun-compiled static binaries for linux/darwin × x64/arm64
- **Installer script** — cross-platform `install.sh` with dependency checking
