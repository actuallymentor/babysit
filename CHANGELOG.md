# Changelog

## 0.5.0 — 2026-04-29

### ✨ Added
- **Auto-attach to tmux on session start.** `babysit <agent>` now drops the user straight into the supervised tmux session instead of leaving them at the babysit cli prompt with the monitor running in the foreground. The supervision loop is forked into a detached `babysit __monitor <id>` daemon that outlives the foreground, so detaching with Ctrl+B d exits the cli but keeps the agent + supervisor running. Re-attach later with `babysit open <id>`. This is what the spec ("the user can detach and re-attach to the session as needed") implied — the previous flow forced the user into a second terminal to actually see the agent.
- The detached monitor sets up its own credential sync loop, so OAuth tokens keep refreshing after the user detaches. The foreground sync is stopped on hand-off to avoid both processes racing on the same tmpfile.

### 🐛 Fixed
- **`babysit resume <id>` ignored the original session's working directory.** `cmd_resume` delegated to `cmd_start` without `chdir`-ing first, so resuming from a different cwd would load whatever `babysit.yaml` happened to be next to the user (or write a fresh default), and `./IDLE.md` / `./LOOP.md` would resolve relative to the wrong place. Now restores `session.pwd` before re-launching, with a warning if the directory has been deleted in the meantime.
- **`config.commands` actions blocked the supervisor while running.** The action executor used `execSync`, which freezes Node's event loop — a slow `notify_command` (curl, network) would suspend pane capture and rule evaluation for the whole duration. Switched to async `spawn` so the monitor keeps ticking.
- **`cmd_open` interpolated session names directly into a shell string.** Names with shell metacharacters (rare but possible if a workspace path is unusual) could break out of the tmux argument. Now delegates to the existing `attach_session` helper, which JSON.stringifies the name for shell safety.

### 🔥 Removed
- `creds_sync_pid` field from session metadata. Never populated — credential sync runs as a `setInterval` inside the babysit process, not as a child PID — so the field was dead weight that mostly served to mislead anyone reading the JSON.

### ✅ Tests
- New `parse.test.js` case locks in the internal `__monitor` verb so future refactors can't silently drop it from the dispatcher.
- New `tests/resume.test.js` covers the chdir behaviour: cmd_resume must restore `session.pwd` before delegating, and must skip the chdir (with a warning) when the original directory has been deleted.

## 0.4.0 — 2026-04-29

### 🐛 Fixed
- **Three credential adapters silently dropped working host logins.** Each surfaced as "babysit launches the agent unauthenticated even though I logged in on the host" — easy to mistake for a network issue.
  - `opencode` on macOS: the darwin layer only handled `keychain_service` + `fallback_file`, so an adapter that declared just `file:` (which is exactly opencode's setup — opencode doesn't use Keychain) was silently skipped. Added a standalone `file:` branch so file-only credentials work on darwin.
  - `codex` OAuth: only `CODEX_API_KEY` / `OPENAI_API_KEY` env vars were forwarded. Anyone who'd run `codex auth login` (which writes `~/.codex/auth.json`) had no creds in the container. Added the file path to the codex adapter and a container target at `/home/node/.codex/auth.json`.
  - `gemini` OAuth: same pattern — only `GEMINI_API_KEY` was passed. Added `~/.gemini/oauth_creds.json` so OAuth-authed users now flow through.
- **Pre-flight token rotation now actually runs.** The sir-claudius lesson was documented in `.notes/GOTCHAS.md` but the code went detect → capture without the rotation step, which meant a near-expiry token would ride the container for 5 min until the sync daemon noticed. Both darwin and linux now invoke `<agent> --version` on the host between detect and capture so the agent's own refresh logic fires before we copy the file.
- **Claude crashed on first session-state write in `--sandbox`.** `~/.claude/{projects,plans,todos}` were bind-mounted read-only when sandbox was set; claude tried to write session JSON on startup and aborted. Now those mounts are skipped entirely in sandbox mode so claude writes ephemerally inside the container.
- **`bun.lock` (Bun 1.2+ text format) wasn't detected as a Node project signal.** Only the legacy `bun.lockb` binary form triggered `node_modules` volume isolation, so newer projects were getting host bind-mounts and the cross-platform binary mismatch the volume isolation was supposed to prevent.

### ✨ Added
- Container image now pre-creates `/home/node/.codex`, `/home/node/.gemini`, `/home/node/.config/opencode`, and `/home/node/.local/share/opencode` with `node:node` ownership. Without these, docker auto-creates the parent dirs as root when the credential file mounts land, blocking the `node` user from writing refreshed tokens or prompt files.
- `mount_credential_file` helper in `credentials/darwin.js` shares the tmpfile + sync setup between the keychain-fallback path and the standalone-file path.

### ✅ Tests
- New `agents.test.js` cases cover credential coverage per agent: codex/gemini OAuth file declared, opencode declares its file on darwin (no Keychain), each adapter declares an absolute container target for `creds`.
- New `docker.test.js` cases assert sandbox skips the writable claude dirs, and `detect_dependency_volumes` recognises `bun.lock`.

## 0.3.3 — 2026-04-29

### 🐛 Fixed
- Codex was reading nothing from babysit's system prompt — the prompt was being written to `${CODEX_HOME}/instructions.md`, a legacy filename current codex no longer honors. The real global-scope path is `${CODEX_HOME}/AGENTS.md` (or `AGENTS.override.md`), so the babysit-generated prompt has been silently dropped on every codex session since v0.3.0. Switched to the correct filename.

### ✨ Added
- Each agent adapter now declares an `home: { env_var, dir }` block — `CODEX_HOME` for codex, `GEMINI_CLI_HOME` for gemini, `CLAUDE_CONFIG_DIR` for claude, `OPENCODE_CONFIG_DIR` for opencode. `build_docker_command` bakes the env var into the docker run, so babysit has a single source of truth for where the agent reads global instructions / credentials / sessions from. This also stops a stray host-side value from leaking through and redirecting the agent to a path the container never mounts.

### ✅ Tests
- New `tests/docker.test.js` cases assert that each adapter's home env var is set in the rendered docker command and that the `system_prompt_file` lives under the declared `home.dir`. The codex case explicitly rejects `instructions.md` to lock in the bug fix.

## 0.3.2 — 2026-04-29

### 🐛 Fixed
- Codex was launched at the wrong reasoning effort in yolo runs — `-c reasoning_effort=high` is silently ignored by codex (the real config key is `model_reasoning_effort`). Switched to `-c model_reasoning_effort="high"`.
- Codex skip-permissions was `--full-auto`, which only skips approvals — its workspace-write sandbox stayed active and blocked edits inside our own docker sandbox. Switched to `--dangerously-bypass-approvals-and-sandbox` so `babysit codex --yolo` actually has full autonomy.
- Default codex model `gpt-5-codex` was not a real model id. Updated to `gpt-5.5` (the latest GA frontier model as of April 2026; users on API-key auth without ChatGPT sign-in can override with `--model gpt-5.4`).
- Default gemini model was the now-superseded `gemini-2.5-pro`. Switched to the rolling `gemini-pro-latest` alias so the spec's "always auto-selects ... latest model" rule keeps holding.
- Container `PATH` didn't include `~/.local/bin` or `~/.opencode/bin`, the install paths used by claude's and opencode's install scripts — `claude`/`opencode` would have resolved to "command not found" at runtime.
- Credential refresh interval kept the event loop alive — if the user interrupted the cli before the tmux session ended, the process would hang on the unfired `setInterval`. Now `unref()`'d.

### 🔥 Removed
- Orphaned mode helpers `src/modes/{yolo,sandbox,mudbox}.js`. They mutated a `context` object that no caller ever passes — the actual mode application is inlined in `docker/run.js` and `modes/prompt.js`.

### ✅ Tests
- `tests/docker.test.js` updated for the corrected codex defaults (effort key, skip-permissions flag, model id) and now asserts `model_reasoning_effort="high"` survives shell-quoting into a single arg.

## 0.3.1 — 2026-04-28

### 🐛 Fixed
- `--no-update` was silently ignored — mri normalises `--no-X` to `{X:false}` rather than `{'no-X':true}`, so `args['no-update']` always missed. Self-update ran on every command, including when the user explicitly opted out
- Compiled binary crashed on startup with `ENOENT: /$bunfs/package.json` — version was read at runtime via `readFileSync(__dirname/../package.json)`, but bun-compiled binaries resolve `__dirname` to `/$bunfs`. Switched to JSON import attribute so the file embeds at build time
- Compiled binary crashed when building the system prompt — `src/modes/prompt.js` read `system_prompt/*.md` via the same `__dirname`+`readFileSync` pattern. Converted the fragments to JS-exported string constants in `src/system_prompt/index.js` so they bundle into the binary

### 🔥 Removed
- `get_statusline_path` — unused export with the same `__dirname`/`readFileSync` issue. The container's statusline.sh path is hard-coded into the Claude settings tmpfile, so the function had no callers
- `src/system_prompt/{base,yolo,sandbox,mudbox}.md` — content moved into `src/system_prompt/index.js`

### ✅ Tests
- New `tests/prompt.test.js` covers each mode flag → fragment combination
- New `parse.test.js` cases lock in `--no-update` recognition

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
