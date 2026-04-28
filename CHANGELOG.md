# Changelog

## 0.2.0 — 2026-04-28

### 🐛 Fixed
- `babysit resume <id>` is now wired to the resume dispatcher (was crashing with "Unknown agent: null")
- `send_shift_tab` now sends the tmux key name `BTab` instead of the unrecognised literal `\x1b[Z`
- `babysit <agent> resume <id>` no longer duplicates the session id between the agent's resume flag and passthrough
- `codex` resume honours the supplied session id (previously always used `--last`)
- `parse_args` no longer halts on the first unknown flag (mri's `unknown` callback returns the callback's value, not the parsed object)
- `send_text` uses tmux `send-keys -l` so `$`, `!`, and backticks pass through as literal text
- `cmd_resume` flag merge — explicit user flags now win over stored modifiers, so `babysit resume <id> --yolo` actually adds yolo

### ✨ Added
- Statusline path is now end-to-end wired: `BABYSIT_MODIFIERS` env, idle countdown file (`/tmp/babysit-loop-deadline`), and a Claude `settings.json` tmpfile that merges host settings with the babysit override (no host mutation)
- `IdleTracker.get_deadline( timeout_s )` publishes the next idle deadline so the statusline can render a countdown
- Self-update pre-flight now also pulls the babysit repo when installed via `git clone`

### ♻️ Changed
- `babysit/yaml.js` now imports `parse_timeout` from `babysit/timeout.js` instead of carrying a near-duplicate inline parser

### ✅ Tests
- New tests for `parse_args` (covers session-id de-duplication and unknown-flag passthrough)
- New tests for `build_claude_settings_tmpfile` and `write_loop_deadline`
- New tests for `IdleTracker.get_deadline`

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
