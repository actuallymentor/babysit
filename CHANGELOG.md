# Changelog

## 0.3.0 — 2026-04-28

### 🐛 Fixed
- Docker image namespace mismatch — `src/docker/update.js` was pointing at `babysit/babysit` but the publish workflow ships `actuallymentor/babysit`, so `docker pull` and `docker run` would both fail at runtime
- `codex resume` now uses the interactive subcommand — previously routed through `codex exec resume`, which is non-interactive and can't be supervised through tmux
- `build_docker_command` shell-quotes every value before joining — multi-line system prompts, env values containing spaces / `$` / quotes, and paths with spaces are no longer mangled by `sh -c`
- `parse_args` rejects `--sandbox --mudbox` instead of silently picking one — the mount strategies are contradictory
- `babysit resume <id>` keeps unknown passthrough flags — `--model sonnet` and friends were previously dropped on the agent-less form
- `cmd_resume` errors out informatively when no stored session is found — used to silently fall back to claude

### ✨ Added
- System prompt is now injected for codex / gemini / opencode (previously only claude got one) — passed via `BABYSIT_SYSTEM_PROMPT` env, the entrypoint appends it to the agent-specific config file (`AGENTS.md` for codex/opencode, `GEMINI.md` for gemini)
- Codex defaults: `--model gpt-5-codex` and `-c reasoning_effort=high`, per spec "always auto-selects the maximum effort and latest model"
- `babysit list` and `babysit open` now run the dependency check and self-update pre-flight (with `--no-update` to opt out), per spec "On any babysit command"
- `scripts/install.sh` now offers to install missing dependencies via the detected package manager (brew / apt-get / dnf / pacman) instead of just printing hints

### ♻️ Changed
- `base.md` system-prompt wording aligned with the spec ("Docker container", not "Babysit Docker container")
- `src/tmux/session.js#create_session` no longer accepts an `env` parameter — the dead code path had its own (broken) quoting
- Codex / gemini / opencode adapters now declare a `container_paths.system_prompt_file` so the docker run can target the right path

### ✅ Tests
- New `tests/docker.test.js` covers: docker image name, codex resume shape, system-prompt-file paths, and shell-quoting of values with spaces / quotes / `$`
- Parse test covers sandbox+mudbox rejection and resume passthrough preservation

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
