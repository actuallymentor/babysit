# Changelog

## 0.9.1 — 2026-05-03

### 🐛 Fixed
- **`--log` no longer consumes the next agent passthrough flag.** Bare `--log`
  now uses the normalized argv for passthrough collection, so
  `babysit claude --log --model sonnet` still forwards `--model sonnet`.
- **Dead-session resume no longer enables logging unless `--log` is passed.**
  Resume flag merging now preserves `log: false` while still honoring bare
  `--log` as the default-path sentinel.
- **`--log` now starts the tmux pipe before the agent command runs.** Fast
  startup output is captured without echoing the docker boot command into the
  pane or logfile.

## 0.9.0 — 2026-05-03

### ✨ Added
- **`--log` flag** appends all tmux pane output to a logfile. Three call shapes accepted:
  - `babysit claude --log` → default path `.YYYY_MM_DD_HH_MM.babysit.log` in cwd (hidden, named after session start time)
  - `babysit claude --log=path.log` or `--log path.log` → custom path
  - Absolute and `~/`-prefixed paths supported.

  Each new session prepends a `Babysit session start: YYYY-MM-DD HH:MM:SS` line so the same file can host multiple sessions without ambiguity. Logging is implemented via `tmux pipe-pane` (server-side, survives detach), so the file keeps growing while you're reattached, detached, or running headless. Files are append-only — never truncated. tmux writes raw bytes including ANSI; pipe through `sed -E 's/\\x1B\\[[0-9;?]*[a-zA-Z]//g'` for plain text. Implementation: `src/utils/log_file.js` (path resolution, header) + `start_pipe_pane` in `src/tmux/capture.js`.

## 0.8.0 — 2026-05-02

### 🐛 Fixed
- **`babysit claude --yolo` no longer shows the "Bypass Permissions mode" warning dialog at every launch.** Claude only suppresses the warning when `skipDangerousModePermissionPrompt: true` is persisted in user-scope `settings.json`; the `--dangerously-skip-permissions` CLI flag alone doesn't dismiss it. Babysit now injects that key into the merged settings tmpfile (`build_claude_settings_tmpfile` in `src/agents/setup.js`) when yolo is on, threaded through `claude_extra_mounts` and `get_extra_mounts`. The host's `~/.claude/settings.json` is still untouched — only the in-container view gets the override. Mac was the most visible case because most fresh hosts haven't accepted the dialog locally yet.
- **`babysit codex` (and gemini/opencode) no longer fails with "refresh token was already used" inside the container.** Cause: credential sync was one-way (host → container). When the in-container agent rotated its OAuth refresh_token (one-time-use on OpenAI / Google), the new state landed in the bind-mounted tmpfile but never flowed back to the host's `~/.codex/auth.json` (or `oauth_creds.json`). Next babysit session copied the stale, server-invalidated token forward and the container's first refresh attempt blew up. Pre-flight `<agent> --version` was assumed to rotate tokens like it does for claude, but codex/gemini/opencode only refresh on real API calls — silent no-op. Sync is now bidirectional: `start_credential_sync` takes a `write_destination` callback; on every tick + on `stop()`, container-side updates get pushed back to the host source. Conflict policy: source wins (host re-auth beats container refresh). Keychain-backed claude on darwin keeps one-way sync. **Recovery for users hitting this now**: re-auth on the host (`codex auth login` / `gemini auth login` / `opencode auth login`); the bidirectional sync only prevents *future* invalidations.

### 🔥 Removed
- **Auto-update sweep on every command is gone.** Previously every `babysit start` / `resume` / `list` / `open` triggered a parallel `git pull` on the babysit repo, `git pull` on `~/.agents`, `docker pull`, and (in some local versions) a host-agent CLI upgrade pass. Convenient when it worked, surprising and slow when it didn't — flaky networks turned a 1s session start into a 15s timeout cascade, and stable installs got nothing from the daily churn. Updates are now explicit: run `babysit update` to refresh everything in one sweep. The dep check still runs on every command — that's cheap and catches a missing docker/tmux before we hit a confusing downstream error.
- **`--no-update` flag.** Existed solely to skip the implicit auto-update; with the auto-update gone, the flag has no purpose. Anyone still passing it will see the token forwarded to the agent CLI as passthrough.

### ✨ Added
- **`babysit update` now also upgrades host-installed coding agent CLIs.** New Step 4 in the narrated sweep loops over `claude` / `codex` / `gemini` / `opencode`, skips agents not on PATH, and tries the registered strategies in order (`self_update` → `npm` → `brew`, gated by realpath detection so an npm-installed agent never accidentally triggers brew). Per-agent strategies declared on each adapter; runner lives at `src/deps/agent_update.js`. Step labels updated `[1/3]` → `[1/4]` etc.

## 0.7.0 — 2026-05-01

### ✨ Changed
- **Install target moved from `/usr/local/bin` to `~/.local/bin`** so neither the installer nor `babysit update` ever needs sudo. `scripts/install.sh` now `mkdir -p`s the user-local bin, drops the binary there, warns if `~/.local/bin` isn't on PATH (with the exact line to add to a shell rc), and warns if a legacy `/usr/local/bin/babysit` is still around shadowing the new install. `babysit update` follows the same convention via a `USER_INSTALL_DIR` constant kept in sync with the installer. The previously-required `sudo mv` fallback in update.js is gone.
- **Migration path for users with the old `/usr/local/bin` install**: `babysit update` detects when `process.execPath` lives in a non-user-writable dir, writes the fresh binary to `~/.local/bin/babysit` instead, and prints a one-time notice with the exact `sudo rm` command to clear the legacy copy. Babysit itself never escalates — the only sudo in the whole flow is the manual cleanup the user chooses to run. New tests in `tests/update.test.js` cover the `is_on_path` PATH-ordering check that gates the warning.

## 0.6.3 — 2026-05-01

### 🐛 Fixed
- **Codex emitted `codex_apps` MCP token_expired warning on every container startup.** The `apps` feature (default-on per `codex features list`) spawns the codex_apps MCP, which demands a fresh OAuth access token from OpenAI's hosted-connectors endpoint at startup. Babysit's pre-flight refresh (`<agent> --version`) does NOT actually rotate the codex token — confirmed empirically that none of `codex --version`, `codex login status`, `codex mcp list` modify `auth.json`. So any container started >1h after the host's last interactive codex run reliably hit `MCP client for codex_apps failed to start: token_expired`. Babysit now writes `[features]\napps = false` into the mounted `config.toml` (equivalent to `codex --disable apps`), suppressing the connector entirely. The connectors are useless inside a sandboxed coding-agent container anyway; users who need them can re-enable per-session with `babysit codex -- -c features.apps=true`. See GOTCHAS.md #37.
- **Codex warned `Codex could not find bubblewrap on PATH` on every container startup.** The `node:24-slim` base image doesn't ship bubblewrap, so codex fell back to its vendored copy with a noisy heads-up. Added `bubblewrap` to the Dockerfile apt-get list. See GOTCHAS.md #38.

## 0.6.2 — 2026-05-01

### ✨ Added
- **`babysit update` now also refreshes the compiled binary.** Step 1 picks the right path automatically: `git pull --ff-only` for source checkouts, or for compiled installs (the `scripts/install.sh` path) it hits the GitHub Releases API, picks the `babysit-${os}-${arch}` asset matching the current platform, downloads it via curl, and `mv`s it over `process.execPath` (with a `sudo mv` fallback for root-owned install dirs like `/usr/local/bin`). Skips the download when the latest tag matches the running version. Tests in `tests/update.test.js` lock in the platform-tag mapping and the compiled-binary detection.

## 0.6.1 — 2026-05-01

### 🐛 Fixed
- **Claude still popped the theme picker on fresh containers**, despite the v0.6.0 onboarding-bypass mounts. Claude ≥ 2.1.x added a `lastOnboardingVersion` gate: if the installed version is newer than the recorded one, claude reruns the version-delta onboarding (theme picker) even when `hasCompletedOnboarding: true`. Because the Dockerfile pulls the latest claude on every image build, the host's recorded version was almost always behind the container's. Babysit now also pins `lastOnboardingVersion` to a sentinel (`9999.0.0`, exported as `ONBOARDING_VERSION_SENTINEL`) high enough to outpace any plausible future release. New regression test in `tests/setup.test.js`.

### ✨ Added
- **`babysit update` — verbose self-update.** Runs the same three steps as the silent pre-flight (git pull on the babysit checkout, git pull on `~/.agents`, docker pull on the babysit image), but narrates each step (`[1/3] … ✓ succeeded`) with absolute paths and skip reasons so the user can see what's local-only, what's a compiled-binary install, and which step failed. Sequential rather than parallel so the output reads top-to-bottom. Excluded from the pre-flight wrapper to avoid double-pulling.

## 0.6.0 — 2026-05-01

### 🐛 Fixed
- **Claude rendered a blank pane forever in supervised sessions.** Tmpfiles babysit bind-mounted into the container were created with `writeFileSync(path, content, { mode: 0o666 })` — but Node masks the mode arg by the host umask, so the file landed at 0o644 / 0o664 and the container's `node` user (uid 1000, neither owner nor group) lost write access. Claude updates `.claude.json` in place during init; the silent EACCES left the TUI hanging mid-render. Fix: explicit `chmodSync(path, 0o666)` after every `writeFileSync` for bind-mounted tmpfiles, hoisted into `src/utils/tmpfile.js` (`copy_host_file_to_tmpfile`, `build_tmpfile`, `rewrite_tmpfile`). All five callers (`credentials/{linux,darwin,refresh}.js`, `agents/setup.js`) now route through it.
- **Claude pops the theme picker + workspace-trust dialog on every fresh container.** `.claude.json` was never mounted, so claude treated each session as a brand-new install. Neither has a CLI flag override (`--dangerously-skip-permissions` only affects tool approvals). Babysit now copies the host's `~/.claude.json` to a tmpfile, injects `hasCompletedOnboarding: true` and `projects[/workspace].hasTrustDialogAccepted: true`, and bind-mounts it.
- **Codex pops "Do you trust the contents of this directory?" + "Try new model" intros on every fresh container.** Trust state lives in `~/.codex/config.toml` per-directory; model nags live in `[tui.model_availability_nux]`. Babysit now copies + injects `[projects."/workspace"] trust_level = "trusted"` and pre-marks every model in `CODEX_KNOWN_MODELS_FOR_NUX` as seen.
- **Codex `installation_id` mount triggered "Failed to create session: Operation not permitted"** on `/home/node/.codex/sessions`. Discovered empirically; cause unclear. Babysit explicitly does NOT mount installation_id; regression test in `tests/setup.test.js` locks this in.
- **Gemini ignored its OAuth tokens and dropped into the auth-method picker.** `~/.gemini/oauth_creds.json` alone isn't enough — gemini reads `auth.selectedType` from `settings.json`. Babysit now mounts `settings.json`, `google_accounts.json`, `installation_id`, `state.json`, plus a synthesized `trustedFolders.json` with `/workspace: TRUST_FOLDER`.
- **Forced `gemini-pro-latest` 404'd for free-tier users.** Pro routing was restricted to paid plans (Code Assist for Individuals returns "Model not found"). Removed the babysit default for gemini's model — gemini's own agent router picks based on the user's plan.
- **Opencode's default `gpt-5.5-pro` is rejected by ChatGPT-account auth** with "model not supported when using Codex with a ChatGPT account", which stalled the session on the first message. Babysit's opencode default is now `openai/gpt-5.5`, which works for both OAuth and API-key paths. Anthropic / Google users override via `--model`.
- **Claude `~/.claude/{projects,plans,todos}` bind mounts had silent host perm bleed.** When claude tried to write, EACCES; when claude worked around it with `sudo chown -R node:node`, the chown propagated back to the host bind mount and silently changed ownership of the user's host dirs. Switched to named docker volumes (`babysit-claude-{projects,plans,todos}`) — claude has full write access, host dirs aren't touched, `babysit resume` still works because the volume persists across container restarts.

### ✨ Added
- **`extra_args(mode)` field on the agent adapter shape** — per-agent CLI args that aren't covered by `--yolo` / `--append-system-prompt` / `--model` / `--effort`. Used by `gemini` to pass `--skip-trust` under `--yolo` (where the user has explicitly opted into "trust this run, no questions"). Outside yolo, the `trustedFolders.json` mount is the source of truth and the flag is omitted.
- **`src/agents/setup.js`** — per-agent `*_extra_mounts` builders (`claude_extra_mounts`, `codex_extra_mounts`, `gemini_extra_mounts`, `opencode_extra_mounts`) consolidated into one file. `docker/run.js` now dispatches via `get_extra_mounts(agent.name)()` and the giant claude block in run.js is gone.

### ♻️ Refactored
- Pulled `build_claude_settings_tmpfile` and the new `build_claude_json_tmpfile` out of `src/statusline/render.js` (which was the wrong home — they're agent-config builders, not statusline concerns) and into `src/agents/setup.js`. `statusline/render.js` is now just `write_loop_deadline` + `LOOP_DEADLINE_PATH`.
- Replaced the if-chain dispatcher in `setup.js#get_extra_mounts` with a registry map.
- `inject_codex_first_run_bypass` is now a separately-testable helper that's idempotent and works on empty input (so a fresh-install user with no `~/.codex/config.toml` still gets `/workspace` trust + nux suppression).

### 📚 Patterns
- Rewrote all four `src/patterns/<agent>.js` based on real captures from triggering plan mode in each agent. Claude's structured numbered prompt (`Yes, and use auto mode` / `manually approve edits` / `refine with Ultraplan`) and codex's `Implement this plan?` dialog are now matched literally; gemini and opencode have no structured plan UI and rely on free-form `Would you like me to proceed?` patterns. `tests/patterns.test.js` exercises each agent against real fixture strings (and asserts a normal chat reply does NOT match plan patterns) so a vendor UI change surfaces as a test failure rather than a silent supervisor regression.

### ✅ Tests
- `tests/setup.test.js` (new) covers `build_claude_settings_tmpfile`, `build_claude_json_tmpfile`, the `*_extra_mounts` builders, the codex `installation_id`-exclusion regression, and asserts each tmpfile lands at chmod 666.
- `tests/agents.test.js` extended with model-defaults coverage (opencode `openai/gpt-5.5`, gemini empty, claude/codex unchanged) and `gemini.extra_args` mode-gating.
- 151 tests across 13 files (was 125).

## 0.5.1 — 2026-04-29

### 🐛 Fixed
- **Rules with `timeout:` never fired while the agent was busy.** The monitor was gating non-idle rules (literal/regex/plan/choice) on whole-pane `idle_seconds`, which meant a `- on: /error/i\n  timeout: 05:00` rule would only ever fire if the *entire* pane went silent for 5 minutes — exactly the case the user already gets from `on: idle`. The spec is "the match is the latest seen output for longer than the timeout" — i.e. time the *match* has persisted, regardless of unrelated output churn. Now tracks `first_matched_at` per rule and gates on that, so a busy agent that's been showing an error for 5 minutes does trip the notify rule. Idle rules are unchanged because their timing is already correct via `IdleTracker`.
- **Resume-hint wording now matches the spec literally** — `"To resume this session, run \`babysit resume <session_id>\`"` instead of the previous `"Session ended. Resume with \`babysit <agent> resume <id>\`"`. Both forms work, but the spec calls out the bare-resume form (which looks the agent up from session metadata) as the canonical one.

### ✨ Added
- **Container parity with sir-claudius's apt set.** Spec calls for "the dependencies that sir-claudius has in the image as well"; we were missing `less`, `shellcheck`, `sqlite3`, `tree`, `unzip`, `gh` (GitHub CLI), and `scc` (LOC counter). Added all seven and refreshed `AGENTS.md` so the container reference doc surfaces them.
- `should_fire_rule` is now exported from `src/babysit/monitor.js`. Splitting the gate logic out of the monitor loop made it unit-testable; the new `tests/monitor.test.js` (12 cases) exercises each rule type and the per-rule timer behaviour.

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
