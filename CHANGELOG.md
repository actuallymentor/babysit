# Changelog

## 1.27.1 — 2026-10-08

### Fixed
- Claude's newer footer `2 shells, 2 monitors · ← for agents` (comma-separated counts, `›` composer, agent rows below the footer) now keeps the session in `waiting`, so idle rules no longer fire while background shells or monitors are still running. Any non-zero count holds; `0 shells, 0 monitors` returns to idle.

## 1.27.0 — 2026-10-08

### Added
- `babysit resume` shows the newest 10 history rows by default. `-n N` shows N rows; `--all` now shows every workspace and every row. Row numbers stay aligned with the full history, so `babysit resume 12` still works when only 10 rows are shown.
- `babysit exit` asks `You may only exit if the user explicitly told you to do so, not because you are done. Exit? Y/n` before queueing the exit. Enter, `y`, or `yes` confirms; `n` cancels; without a terminal on stdin (agent tool calls) it refuses and points at `--yes`, which skips the prompt. `--status` without an id is rejected rather than treated as an exit.

### Changed
- The system prompt now tells agents to run `babysit exit` only when the user explicitly asks to end the session, never because their work is done.

## 1.26.1 — 2026-10-08

### Fixed
- `babysit prune` no longer fails every run on a quarantined clone with root-owned files (`EPERM: chmod`). Such trees are deleted through a root container on the Babysit image; if that fails, prune prints the `sudo rm -rf` path once and continues to the listing.

### Changed
- The YOLO system prompt now says autonomy applies to tasks explicitly given in the session, that branch names, repository state, and notes are context rather than instructions, and that the agent should ask for a task when none was given. (Committed after the 1.26.0 release was cut, so 1.26.0 binaries do not carry it.)
- CI caches the pinned Codex and Claude Code CLIs between regression runs instead of reinstalling them each time.

## 1.26.0 — 2026-10-08

### Added
- `run_on_start: true` on an `on: idle` rule fires the action on the first idle (30 seconds of quiet) instead of waiting a full `timeout`; later fires use the timeout. `--loop` keeps the flag when it overrides the idle action.

## 1.25.3 — 2026-10-08

### Fixed
- `--config FILE` idle rules now win over `--loop`. The launch menu remembers the loop toggle, so a config with its own `on: idle` action was silently replaced by `./LOOP.md` or `~/.agents/LOOP.md`. Relative `.md` actions (`do: ./FILE.md`) also resolve beside the config file first, so a config outside the workspace finds its own instruction files. Named `config.commands` keep precedence over same-named files, and a clone session runs the clone's copy of markdown named by an in-tree config.

## 1.25.2 — 2026-10-07

### Fixed
- A host re-login seen by credential sync before the container transport connected was recorded as delivered without being pushed; a later pull of the container's older token could then overwrite the new host login. Such changes are now deferred until the transport connects and pushed then.

## 1.25.1 — 2026-10-07

### Fixed
- `babysit restart` guards after review: refuses sandbox sessions, requires a recognised idle/waiting control checked right before closing, requires a captured native session id unless `--force`, and keeps the launch's credential profile and agent arguments across close and resume. `--force`/`--detach` parse before the selector too. X clipboard tools get `>/dev/null` so tmux input never stalls.

## 1.25.0 — 2026-10-07

### Added
- `babysit restart <number|id>` rebuilds a session on the current Docker image without losing the conversation: graceful close (credentials flush to the host), then resume by the agent's native session id. It refuses unless the agent shows an idle or waiting control and a native session id is known, `--force` overrides both; sandbox sessions are never restarted. The launch's credential profile and agent arguments carry over. `--detach` skips the attach. Prints whether the image changed.
- A plain mouse drag in a babysit tmux session now copies to the system clipboard and leaves copy mode, no Option or Shift needed. Uses `pbcopy`, `wl-copy`, or `xclip`/`xsel` under X when present, and tmux's OSC 52 forwarding otherwise (needs a terminal that allows clipboard writes). Scroll-wheel scrollback is unchanged.

## 1.24.1 — 2026-10-07

### Fixed
- Credential sync now connects before the bootstrap gate opens, so a lost release acknowledgement can no longer drop a token the agent rotated. Headless probes never defer their upload.

## 1.24.0 — 2026-10-07

### Changed
- Launch uploads credentials and generated config into the *running* container instead of the stopped one. A stopped-container `docker cp` mounts the rootfs and took 5 to 10 seconds on a busy daemon; into a running container it takes milliseconds. The image entrypoint now parks on a bootstrap gate until the launcher has staged files and registered credential recovery, then releases it with one `docker exec`. Images without the `babysit.bootstrap-gate` label (older pulls, pinned recovery images) keep the previous stopped-container path. Pull the new image with `babysit update` to get the faster start.

## 1.23.0 — 2026-10-07

### Added
- `babysit list` prints an orange "New babysit version available" line when GitHub has a newer release. The check is cached for six hours in `~/.babysit/latest-version.json` and refreshes in the background, so listing never waits on the network.

### Changed
- `babysit list` CPU figures are a share of the whole Docker host, not per core: 150% on a four-core host shows as 37.5%. The totals row and its color follow.
- Session monitors poll less: the native identity probe idles to every 30s once an identity is known and the web completion reader polls every 5s. Each poll is a `docker exec`, and eleven sessions were putting ~14 execs per second on the daemon.

## 1.22.1 — 2026-10-07

### Fixed
- `babysit list --watch` says when every running session is archived instead of claiming there are none.
- `babysit model --help` no longer promises only complete benchmark rows.

## 1.22.0 — 2026-10-07

### Changed
- `babysit model` no longer drops models that lack a coding or agentic score; missing metrics show as `—` and sort last. `--all` is accepted but changes nothing.

## 1.21.0 — 2026-10-07

### Changed
- `babysit list --watch` hides archived sessions; selector numbers stay the same as in the plain list, so `babysit open <n>` is unaffected.

## 1.20.0 — 2026-10-07

### Added
- `babysit loop` inside a session toggles `--loop` live: the idle rule, the FLAGS column in `babysit list`, the tmux bar label, and resume all follow. It prints "Looping is now enabled" or "Looping is now disabled".

## 1.19.1 — 2026-10-07

### Fixed
- `babysit --config FILE` (no agent) opens the launch menu and keeps the config file for the chosen session.

## 1.19.0 — 2026-10-07

### Added
- `--config FILE` uses any YAML file instead of `./babysit.yaml`; the path is stored on the session so the monitor, resume, recovery, and clone creation read the same file.
- `babysit init` asks for the config file name (or takes it as an argument) and prints the matching `--config` hint.

## 1.18.1 — 2026-10-07

### Changed
- `babysit init` writes a fully commented `babysit.yaml` that documents every setting and rule form; nothing in it is active until uncommented.

## 1.18.0 — 2026-10-07

### Changed
- Launching no longer writes a `babysit.yaml` into the workspace; a missing file means the defaults. `babysit init` writes the commented default file on request and refuses to overwrite one.

## 1.17.0 — 2026-10-06

### Added
- `babysit list --watch` redraws the listing in place every 2 seconds with full colors. External `watch` pipes the output and older versions drop the 256-color orange and greys.

## 1.16.2 — 2026-10-06

### Fixed
- Archived rows and the idle status use fixed 256-color greys, so they stay visible and subdued under remapped palettes such as Solarized.

## 1.16.1 — 2026-10-06

### Added
- `babysit archive <number|id|name>` dims a session and moves it to the bottom of its workspace in `babysit list`; a workspace whose sessions are all archived is dimmed and moved to the bottom of the list. `babysit open` un-archives. `open`, `close`, and `archive` numbers follow the displayed order.

## 1.16.0 — 2026-10-06

### Added
- `babysit exit` inside a session ends it gracefully: the session is marked intentionally closed, the agent receives `/exit` once its composer is idle, and a forced close follows after 30 seconds if it never quits. The system prompt tells agents it exists.
- `babysit stuck` inside a session shows the session as red "stuck" in `babysit list` until the user types into its tmux session or sends input from the web companion.

### Removed
- `on: plan` and `on: choice` rules and the per-agent pattern tables behind them. Every supported agent has a native bypass mode and plan UI; the patterns had been frozen since May and misfired on current Claude footers.
- `do: shift_tab` and `do: accept`; `enter` is the only key action.
- `config.lines_for_literal_match` and `config.lines_for_regex_match`; literal and regex rules always look at the last 10 pane lines.
- `timeout` on literal and regex rules (they fire as soon as they match; a timeout there now warns). Idle rules keep theirs.

### Fixed
- `--loop` keeps a custom `timeout` on the idle rule instead of silently reverting to `idle_timeout_s`.

## 1.15.1 — 2026-10-06

### Fixed
- Git-mode clones keep every branch, tag and remote-tracking ref, read dirtiness without touching the source, carry wholly ignored folders as a unit instead of walking dependency trees, and fall back to copying when the repository declares attribute filters such as LFS.
- The monitor's usage sampler finishes an in-flight sample before shutdown, never blocks on the session record lock, and retries a failed host capacity read only every ten minutes.

## 1.15.0 — 2026-10-06

### Added
- `babysit list` colors the status column (grey idle, green running, orange waiting) and ends with a totals row colored against the Docker host's cores and memory (green under 50%, yellow under 70%, red above).

### Changed
- Container CPU/MEM are cached on the session record by each session's monitor every 30 seconds; `list` reads the cache instead of calling Docker. Memory shows whole MiB with a space before the unit. Sessions started before this version show `-` until relaunched.
- The TMUX attachment column moved to `list --all`.

## 1.14.0 — 2026-10-06

### Added
- `--clone` on a repository clones its committed state with `git clone` instead of copying the working tree, then carries untracked and ignored files matching `config.clone.carry` (`.env`, `.env.*`, `.notes`, `babysit.yaml` by default). A 285 MB workspace now clones in about a second instead of twenty.
- `config.clone.changes: true` carries uncommitted edits (staged and unstaged state kept) and untracked files; `config.clone.depth` clones shallow history; `config.clone.mode: copy` keeps the working-tree copy.
- `config.clone.exclude` skips names at any depth in both modes; `node_modules` by default.
- macOS working-tree copies use APFS file clones when the filesystem supports them.

### Changed
- The clone prompt tells the agent that dependencies and ignored build output are absent.

## 1.13.2 — 2026-10-06

### Fixed
- `babysit list` samples only running Babysit containers, so CPU/MEM no longer show `-` on daemons with many containers where a full sample exceeded the deadline.

## 1.13.1 — 2026-10-05

### Changed
- `babysit list` gives the container usage sample a 4-second deadline so a sluggish Docker daemon cannot stall the listing; usage shows `-` instead.

## 1.13.0 — 2026-10-05

### Added
- `babysit list` shows each session container's CPU and memory usage, sampled with `docker stats` alongside the pane check.

## 1.12.1 — 2026-10-03

### Added
- Session listings separate workspace trunks with a blank line.
- A launch that had to run a real authentication probe suggests `babysit auth init`; `babysit config` shows whether the checker is installed.
- `babysit auth init` enables user lingering on Linux so the checker runs while logged out; `--no-linger` opts out.

## 1.12.0 — 2026-10-03

### Added
- `babysit auth init` installs an hourly host-level authentication checker (systemd user timer on Linux, launchd agent on macOS); `babysit auth check` re-verifies cached logins older than 6h and yields to a starting session; `babysit auth status` shows cache ages.
- Launch shows a live `Starting <agent>: <step>` line and names any startup step slower than 5 seconds.

### Changed
- The base system prompt tells agents to read `~/.agents/AGENTS.md` first, before anything else.
- Authentication cache identity hashes only the login-identity fields of `~/.claude.json`, not the whole file.
- Running sessions re-stamp the authentication cache each time they write a rotated token back to the host.
- A launch waiting behind another authentication check now says so instead of appearing hung.
- Startup asks the Docker daemon for its identity once instead of twice.

## 1.11.0 — 2026-10-02

### Changed
- Render `list`, `open`, and `close` session listings as a tree: one trunk per workspace directory, numbered session leaves beneath it.
- Verify only the launched agent's authentication at startup; `doctor --auth` still covers every installed agent.
- Upload staged credentials as one tar stream instead of one `docker cp` per file; symlinks in staging are refused.
- Recognise Claude Code 2.1.287's permission-mode footer when waiting for the initial prompt.
- Skip the fixed startup grace delay once the agent's TUI is on screen.

### Fixed
- Watchtower inspection no longer times out: `docker ps` runs without per-container size computation.
- Startup no longer stalls 60 seconds and drops the initial prompt on current Claude Code versions.
- Startup no longer re-probes an unauthenticated bystander CLI on every boot.

## 1.10.2 — 2026-10-01

### Changed
- Default Claude to medium effort; preserve explicit effort overrides.

## 1.10.1 — 2026-09-30

### Fixed
- Show only the image version in update output; omit the image hash.

## 1.10.0 — 2026-09-30

### Added
- Show downloaded image versions and IDs; distinguish unchanged images.

### Fixed
- Give Docker pulls the full 120-second update timeout.

## 1.9.4 — 2026-09-30

### Fixed
- Preserve populated cache ownership during authentication probes.

## 1.9.3 — 2026-09-30

### Fixed
- Avoid shared cache initialization races during parallel authentication.

## 1.9.2 — 2026-09-30

### Fixed
- Scope Claude effort readback to its live picker.
- Compile storage tests for the Docker image architecture.

## 1.9.1 — 2026-09-30

### Fixed
- Preserve Linux clone metadata with rsync, including hard links and xattrs (#2).
- Reject stale Claude model/effort confirmations (#3).
- Recognize combined and persistent dim styling in Claude suggestions (#4).

## 1.9.0 — 2026-09-30

### Added
- Show `waiting` while Claude background shells outlive its foreground reply.
- Preserve waiting status in CLI and web; defer idle-rule triggers while waiting.

### Fixed
- Relocate Claude worktrees created at Docker’s `/workspace` mount.

## 1.8.3 — 2026-09-30

### Fixed
- Clone repositories containing Claude worktrees without linking back to source.
- Preserve nested worktree isolation across host and container paths.

## 1.8.2 — 2026-09-30

### Fixed
- Keep bundled OpenCode outside the persistent npm volume so image updates take effect.

## 1.8.1 — 2026-09-30

### Fixed
- Explicitly install latest agent CLIs and refresh image layers on reruns.
- Log bundled agent versions; test Codex 0.159.2 and Claude Code 2.1.285.
- Dismiss initially clipped Claude pickers; follow the current native catalog.
- Install OpenCode through npm to avoid GitHub release lookup failures.

## 1.8.0 — 2026-09-30

### Added
- Append 30 coding-ranked benchmarks to bare `babysit model` listings.
- Preserve available models when benchmark retrieval fails or lacks a key.

## 1.7.1 — 2026-09-30

### Changed
- Shorten container prompts; keep mode boundaries and essential tool hints.
- Remove conflicting workspace and host-isolation claims.

## 1.7.0 — 2026-09-30

### Added
- Add model benchmarks, coding-first sorting, cost/task and cost/point.
- Filter authenticated CLI providers; use `--all` for incomplete metrics.
- Add benchmark limits, JSON output and a shared 15-minute container cache.

### Fixed
- Keep host benchmark caching active when `flock` is unavailable.

## 1.6.1 — 2026-09-29

### Fixed
- Resolve Claude versioned/dated model IDs from live family descriptions.
- Dismiss clipped Claude model pickers instead of leaving the modal stuck.
- Recognize wrapped confirmations and mid-turn notices on narrow terminals.
- Preserve dim composer borders when ignoring Claude prompt suggestions.

### Added
- Real Claude picker regressions in CI; optional subagent control smoke test.

## 1.6.0 — 2026-09-29

### Added
- `--clone` lists unreadable source paths with the exact `chmod`, offers to run it, and retries.
- YOLO answers Claude's bypass-immune "Dangerous rm operation" prompt (`yolo_approve_dangerous_commands`).
- `npm run test:claude-dialog`: live drift report for that prompt after Claude updates.

### Fixed
- Web: stop the orphan sweep dropping a queued message when a slow disk ages its file.
- Keep agent-requested Claude `/model` from orphaning its picker on slash autocomplete.
- Confirm Claude model/effort switches made mid-turn instead of reporting timeouts.
- Treat Claude's dim suggested prompt as an empty composer, not a user draft.
- Scan Claude 2.1.283's wrapping, scrolling picker; reject update-only models.
- Accept Claude API model IDs (e.g. `claude-opus-5-5`) and list ambiguous matches.

## 1.5.1 — 2026-09-26

### Fixed
- Sync Codex host re-login promptly through a debounced credential watcher.
- Retain credential state during incomplete host login writes.
- Respect host Codex logout without restoring credentials or blocking cleanup.

## 1.5.0 — 2026-09-24

### Added
- Prune unused Docker resources while preserving saved sessions and volumes.

## 1.4.0 — 2026-09-24

### Added
- Resume sessions by history number, including explicit-agent and `--all` forms.
- Recover sessions by the numbers shown in `recover --dry-run`.

### Fixed
- Preserve literal agent arguments after `--` without forwarding resume selectors.

## 1.3.0 — 2026-09-23

### Added
- Close active sessions by their `babysit list` number: `babysit close 1`.

## 1.2.2 — 2026-09-23

### Fixed
- Avoid duplicate Escape during native-control cleanup and handle nested effort dialogs.

## 1.2.1 — 2026-09-23

### Fixed
- Preserve queued web input during terminal-control polls.
- Close owned native dialogs after a control request times out.

## 1.2.0 — 2026-09-23

### Added
- Add session-scoped model switching and native Claude/Antigravity effort controls.
- Queue terminal controls safely with expiry and request status.
- Add host/container account usage for Claude, Codex, and OpenRouter.

## 1.1.2 — 2026-09-20

### Fixed
- Capture completed Codex replies after resuming app-server threads natively.
- Wait for the resumed test agent before sending its exit command.

### Added
- Verify real Codex completion capture across normal and YOLO resumes.

## 1.1.1 — 2026-09-20

### Fixed
- Preserve Codex resume/fork permissions through native launch.
- Follow historical resume IDs to their current live or retryable launch.
- Wait for native Antigravity exit before test cleanup.

### Added
- Exercise real Codex resume and permission changes in CI.

### Removed
- Remove Antigravity-specific setup from README.

### Changed
- Condense README into a command-first quick reference.
- Use native Codex resume with permissions; omit live effort controls.

## 1.1.0 — 2026-09-11

### Added
- Show effective paths, menu defaults, and setup status with `babysit config`.
- Report recovery installation, enablement, and runtime state separately.

## 1.0.0 — 2026-09-11

### Breaking
- Replace Gemini CLI with Antigravity (`babysit antigravity` / `babysit agy`).
- Reject legacy Gemini sessions; start a new Antigravity conversation.

### Added
- Carry native Antigravity credentials, settings, hooks, and conversation state.
- Verify interactive completion and exact resume with the real `agy` binary.
- Preserve accepted workspace trust and native keyring credential origins.

## 0.44.0 — 2026-09-10

### Added
- Support `BABYSIT_HOME` for host storage, boot recovery, and web Compose mounts.
- Check storage access as the service account before installing boot recovery.

## 0.43.5 — 2026-09-10

### Fixed
- Preserve clone lock write errors instead of reporting false contention.
- Keep temporary lock cleanup from masking storage errors or stranding an acquired lock.
- Publish complete clone lock records; leave no phantom lock after ENOSPC.

### Changed
- Test interactive prune and recovery from real filesystem exhaustion.

## 0.43.4 — 2026-09-10

### Fixed
- Discover live sessions when web access is initialized after launch.
- Deliver queued web messages fairly and tolerate concurrent request claims.
- Keep web messages pinned to the agent pane after terminal pane switches.
- Keep background Codex diagnostics out of the interactive terminal.
- Replace the hamburger dropdown with a full-height sliding drawer.

### Changed
- Gate CLI and web changes with browser, tmux, and Docker regression tests.

## 0.43.3 — 2026-09-09

### Fixed
- Validate boot executables and Docker access with the service account’s environment.
- Use absolute Ubuntu administration paths through sudo.
- Include boot dependency directories in required service mounts.

## 0.43.2 — 2026-09-09

### Fixed
- Prompt for sudo authentication when installing boot recovery from a terminal.
- Explain how to authorize unattended recovery-service installation.

## 0.43.1 — 2026-09-09

### Fixed
- Prefer verified plain Chrome indexes when compressed repository metadata lags.

## 0.43.0 — 2026-09-09

### ✨ Added
- Add manual `babysit recover [id]`, dry-run/JSON output, and optional continuation suppression.
- Add `babysit recover init` to install per-account Ubuntu boot recovery.
- Add `babysit close <id>` for intentional closure across reboots.

### Fixed
- Persist recovery intent, native conversation identity, and crash-safe registry updates.
- Resume exact conversations with original launch settings; repair missing monitors without duplicate agents.
- Retain interrupted clone workspaces and recover boot-stale locks and credential scratch files.
- Report uncertain continuation delivery and unsupported recovery prerequisites.
- Honor completed-before-shutdown exits and saved credential profiles.
- Let close resolve original IDs through replacement recovery launches.

## 0.42.0 — 2026-09-08

### ✨ Added
- Add a keyboard launch menu for bare `babysit` and session-name arguments.
- Remember menu settings per workspace, with global fallback for new projects.

## 0.41.0 — 2026-09-08

### Added

- Add persistent light/dark/system themes and fluid text with size controls.
- Add mobile Reply shortcut, busy-state drafting, and code copying.
- Show heartbeat freshness and identifiable message delivery feedback.

### Changed

- Refine colors, typography, card density, and mobile app navigation.
- Keep terminal output below the reply flow; constrain desktop reading width.

### Fixed

- Preserve unknown activity and disable sends during connection failures.
- Bound stalled requests and prevent older polls replacing newer state.
- Retain request IDs so delivery results match their queued messages.

## 0.40.0 — 2026-09-08

### ✨ Added
- Add `babysit effort [level]` for managed Codex and OpenCode sessions, with model-specific levels and changes between requests in a running turn. OpenCode uses a plugin override; `default` restores its TUI selection.

### 🐛 Fixed
- Fix activity publication and session parsing with older tmux versions that require exact pane targets and sanitize tab separators.
- Refresh `babysit list` activity from live panes; recognize idle controls despite countdown redraws and keep static interrupt controls running. Report unreadable panes as `unknown`.
- Honor explicit agent model flags without also injecting a default model.
- Preserve existing Codex TOML settings when staging container configuration; handle equivalent key syntax and report invalid input before staging.
- Show only the latest completed agent reply in the web interface; keep terminal output in a separate collapsed view.
- Show the active-session list after agent exit (including `/exit`), as well as detach.
- Show a concise failure message when `babysit update` cannot pull `~/.agents`, without Git's multiline error output.

## 0.39.2 — 2026-09-07

### Changed
- Default Codex to `gpt-6-astra` with `medium` reasoning.

### 📚 Documentation
- **The README is now a focused operator quick reference.** Installation,
  modes, session commands, supervision, web setup, and development remain easy
  to scan without implementation history.

## 0.39.1 — 2026-09-04

### 🐛 Fixed
- **Babysit-web setup now uses Docker Compose throughout.** `babysit web init`
  prints a complete Compose service, and local HTTP development uses a hardened
  loopback-only Compose file instead of a standalone `docker run` command.

## 0.39.0 — 2026-09-04

### ✨ Added
- **Babysit now has a mobile web companion.** The separately published
  `actuallymentor/babysit-web` PWA lists live sessions, renders their latest
  stable output as restricted Markdown, and sends text back to the exact agent
  pane through a narrow host filesystem bridge.
- **`babysit web init` creates the bridge capability.** It prints a
  cryptographically random access key once, stores only its hash, and prepares
  private state, request, and host-only inflight directories for Compose.

### 🔒 Security
- **The web container receives no machine-level control surface.** It mounts
  sanitized session state read-only and a validated request queue read-write;
  tmux, Docker, home, workspace, session-registry, and inflight access remain
  on the host.
- **Browser and request boundaries fail closed.** Rotatable read/write access,
  short-lived secure cookies, same-origin writes, rate limits, strict request
  schemas, bounded queues, exact pane targeting, and control-character
  filtering protect both the web app and tmux delivery path.

### ♻️ Changed
- **Long Babysit actions no longer pause monitor heartbeats.** The monitor keeps
  capturing the pinned agent pane while serialized actions own its input.

## 0.38.0 — 2026-09-04

### ✨ Added
- **Tmux sessions show their launch context.** A bottom status bar displays the
  optional session name, compact source directory, and active launch flags.

### ♻️ Changed
- **Detaching prints the current active-session list.** Fresh launches,
  `babysit open`, and live resumes reuse the normal `babysit list` output.

## 0.37.0 — 2026-09-04

### ✨ Added
- **Clone copies can be inspected and pruned safely.** `babysit prune --list`
  reports clone sizes and activity, while interactive prune supports a 30-day
  default, all-unused cleanup, and custom retention periods.
- **Confirmed prune operations survive interruption.** Clone-family liveness,
  strict ownership checks, final lock-time revalidation, and journaled
  quarantine deletion keep active or uncertain workspaces protected.

### 🐛 Fixed
- **Pruned sessions no longer appear resumable.** Explicit resume attempts now
  explain when their clone was removed, and normal exits record last-use time.

## 0.36.0 — 2026-09-03

### ✨ Added
- **Clone sessions isolate active work in durable copies.** `--clone` copies the
  full workspace to `~/.babysit/clones`, mounts it at `/workspace`, exposes the
  source at `/original`, and creates an isolated Git branch when applicable.
- **Clone resumes survive detached and interrupted sessions.** Durable metadata,
  token-aware monitor ownership, and container recovery preserve the same clone
  across ordinary exits, monitor loss, and abrupt host shutdowns.

### 🐛 Fixed
- **Session records are replaced atomically.** Resume readers no longer observe
  partial JSON when foreground and monitor processes update launch state.

## 0.35.1 — 2026-08-27

### 🐛 Fixed
- **Startup diagnostics stay separate from authentication progress.** Debug,
  warning, error, stack-trace, and multiline output now clear and restore the
  live spinner instead of joining its current line or duplicating progress.

## 0.35.0 — 2026-08-26

### ✨ Added
- **Resume history is workspace-aware.** Bare `babysit resume` prefers sessions
  from the current workspace, falls back to all history when none match, and
  labels filtered output with its workspace. `babysit resume --all` always
  shows every workspace.

## 0.34.0 — 2026-08-24

### ✨ Added
- **Common coding-agent tools are ready in every container.** The image now
  bundles native-build, process, socket, ACL, filesystem-watch, shell-format,
  Git history, source-index, and PDF-structure utilities.

## 0.33.0 — 2026-08-23

### ✨ Added
- **Headful browser automation works out of the box.** The image includes Xvfb,
  X authentication, and X11 diagnostics for sandboxed Puppeteer sessions.
- **Coding agents can inspect and render PDFs.** Poppler's command-line tools
  are preinstalled alongside the browser stack.

## 0.32.3 — 2026-08-22

### 🐛 Fixed
- **Session windows close promptly after `/exit`.** Authentication progress
  restores fresh terminal input to a non-flowing state, so the foreground CLI
  no longer stays alive after printing its resume hint.

## 0.32.2 — 2026-08-22

### 🐛 Fixed
- **OpenCode auth probes recover from opaque server errors.** Probes print
  error-level OpenCode logs and retry its exact generic server wrapper once in
  the same prepared container. Explicit credential failures still fail
  immediately, and one deadline bounds both attempts and credential recovery.

## 0.32.1 — 2026-08-22

### 🐛 Fixed
- **OpenCode uses the provider that owns its credentials.** Explicit and
  configured models still win; otherwise direct OpenAI and OpenRouter auth
  select equivalent provider-qualified frontier models for both startup and
  authentication probes. Provider enable/disable lists are honored, while the
  unpinned fallback lets OpenCode route models and keys loaded inside the
  container from `.babysitrc`, project `.env` files, or config templates.

## 0.32.0 — 2026-08-21

### ✨ Added
- **Coding agents can browse with bundled Chrome and Puppeteer.** The
  multi-architecture image provides one globally importable Puppeteer package
  backed by current Google Chrome Stable, with Chrome's sandbox retained.

### Changed
- **Daily image builds refresh browser and agent tooling together.** BuildKit
  cache invalidation now covers Chrome, Puppeteer, and every bundled coding
  agent; `babysit update` pulls the refreshed runtime.
- **Browser sessions receive stable shared-memory capacity.** Containers use a
  1 GiB `/dev/shm` and a Docker-default-derived seccomp profile that opens only
  Chrome's required namespace calls from a private launch-scoped path, without
  granting `SYS_ADMIN` or passing `--no-sandbox`. Every launch now crosses an
  acknowledged `docker create` boundary before deleting that private profile,
  and cancelled creates reap only their Babysit-generated container name.

## 0.31.1 — 2026-08-21

### 🐛 Fixed
- **Codex startup prompts target its stable composer.** Optional banner/footer
  text no longer causes a silent 60-second wait; blocked screens still reject
  injection and Codex's visible readiness deadline is now 15 seconds.
- **Startup probes only relevant host CLIs.** The active agent is always
  checked, while non-active agents run only when their CLI exists on host PATH.
- **Enter skips the entire startup auth decision.** Completed failures and
  final-probe races no longer resurrect the `Exit?` confirmation.
- **OpenCode auth checks use the real route without tools.** Probes pin the
  effective model, stage sanitized provider routing, disable agent tools, and
  distinguish missing login from model/configuration failures.

## 0.31.0 — 2026-08-21

### ✨ Added
- **Startup verifies every coding agent.** Claude, Codex, Gemini, and OpenCode
  cache misses run concurrently so nested agent calls have real auth coverage.
- **Concurrent launches share authentication work.** A cross-process lease
  prevents duplicate refresh-token use and lets waiters reuse warm results.

### 🐛 Fixed
- **Auth probes stage only their own credentials.** Provider/account state and
  `.babysitrc` remain intact while unrelated secrets and instructions stay out.
- **Probe deadlines cover Docker preparation.** Host preflight and full probe
  setup are bounded without abandoning credential recovery or false-failing
  slow but successful Docker cleanup.
- **Credential rotations reconcile before reuse.** Cache trust and source
  replacement are tracked independently for every supported agent.
- **Slow auth recovery cannot lose lease ownership.** Live launches remain
  serialized through credential pull/removal, while abandoned state recovers.
- **Loaded Docker daemons retain warm auth results.** Image inspection gets a
  realistic bound, and transient container-start inspection timeouts retry
  without delaying hard Docker failures.

### Changed
- **Non-interactive startup now verifies cache misses and fails closed.** It no
  longer silently launches without current all-agent authentication evidence.

## 0.30.1 — 2026-08-21

### 🐛 Fixed
- **Startup prompts reach the active composer exactly once.** Claude and Codex
  reject splash, loading, update, trust, and onboarding screens; bracketed
  paste settles before one Enter so Codex cannot turn submit into a newline.
- **TUI readiness uses a real wall-time bound.** Transient tmux capture errors
  retry until a monotonic deadline, exited sessions stop immediately, and
  `BABYSIT_DEBUG=1` prints the final blocked screen.

## 0.30.0 — 2026-08-20

### ✨ Added
- **Startup authentication is active-agent scoped and skippable.** Successful
  checks use a 12-hour credential/image-bound cache; Enter cancels safely,
  non-interactive misses warn, and `doctor --auth` runs explicit checks.
- **OpenCode prompt delivery waits for its real composer.** Sanitized loading,
  ready, provider, authentication, and model-error screens lock the boundary.

### 🐛 Fixed
- **Session close releases tmux when the agent exits.** A randomized supervised
  exit marker avoids Docker's 10–30-second bookkeeping tail while detached
  cleanup preserves final credential recovery and container removal.
- **Credential preflight runs only where it rotates state.** Claude retains its
  host preflight; Codex, Gemini, and OpenCode skip the serial no-op command.

### Changed
- **Startup phases expose opt-in timings.** `BABYSIT_DEBUG=1` reports dependency,
  Docker, authentication, TUI, tmux, and detached cleanup durations.

## 0.29.0 — 2026-08-19

### ✨ Added
- **Active session launch flags are always visible.** `babysit list` now shows
  comma-separated `FLAGS` such as `yolo,docker` without requiring `--all`;
  sessions without recorded flags show `-`.

## 0.28.1 — 2026-08-18

### 🐛 Fixed
- **Active session status follows viewport activity.** `STATUS` now switches
  from `running` to `idle` after one unchanged monitor interval instead of
  waiting for the idle-supervision timeout.

## 0.28.0 — 2026-08-18

### ✨ Added
- **Active sessions report coding-agent activity.** `STATUS` shows `running`
  or `idle` using the same timeout as Babysit's idle supervision.
- **Verbose active-session diagnostics are opt-in.** `babysit list --all`
  restores the separate ID and full tmux session-name columns.

### Changed
- **The default active-session table is compact.** `NAME` falls back to the
  session ID, tmux attachment state lives under `TMUX`, and the raw session
  name is replaced by the deepest two working-directory levels.

## 0.27.0 — 2026-08-07

### ✨ Added
- **Host agent profiles can be isolated per session.**
  `--ignore-host-agents-md` omits host instructions, skills, preferences, and
  global loop context while retaining credential-only state and project-local
  context, including active GitHub Enterprise authentication. The setting
  persists across both `babysit resume` forms. GitHub's isolated profile uses a
  `docker create`/`docker cp` transport shared by generated agent config,
  credential files, and secret environment values. It works through nested
  Docker daemons without exposing secrets in Docker `Config.Env`/inspect or
  bind-mount metadata, keeps refreshed OAuth files synchronized, refuses unsafe
  live-session isolation upgrades, and removes stopped containers only after
  the monitor's final credential flush. Failed probe/startup flushes now retain
  recoverable containers and sync files, while serialized sync checks prevent a
  slow Docker pull from overwriting a concurrent host reauthentication. The
  foreground connects before container start and finishes its final pull before
  the monitor takes ownership. Durable recovery markers protect captured files
  even before the main container exists, macOS Keychain handoffs preserve the
  transferred baseline, and signal cleanup removes static-secret-only containers.

## 0.26.2 — 2026-08-07

### 🐛 Fixed
- **Fresh configurations are inert until enabled.** Generated examples no
  longer reference a missing `IDLE.md` or run placeholder notifications.
- **Semantic acceptance sends Enter.** `accept` no longer emits Shift+Tab, and
  resume tests never write to the user's session registry.

### Changed
- **Agent defaults match current CLIs.** Claude uses `xhigh`, Gemini uses
  `--approval-mode=yolo`, and OpenCode uses `openai/gpt-5.6-sol`.
- **Pinned build tools are current.** Container utilities, Bun, nvm,
  actions/cache, and the transitive browser database helper were refreshed.

### Removed
- **Obsolete project scaffolding is gone.** Removed the superseded self-update
  module and unused Babel preset.

## 0.26.1 — 2026-08-07

### 🐛 Fixed
- **Watchtower registry aliases are recognized consistently.** Compatibility
  checks now normalize Docker Hub registry prefixes before matching images.

## 0.26.0 — 2026-08-06

### ✨ Added
- **Watchtower compatibility checks protect active sessions.** Babysit now
  recognizes confirmed-safe Watchtower images and registry aliases, while a
  prominent startup warning identifies unknown or unsafe legacy variants that
  may replace the agent container.

## 0.25.1 — 2026-08-06

### 🐛 Fixed
- **Active sessions are protected from unattended replacement.** Babysit now
  labels agent containers so Watchtower leaves their stateful tmux sessions
  running.

### Changed
- **Dependencies are current and vulnerability-free.** The YAML runtime was
  updated to 2.9.0, and compatible development dependencies were refreshed to
  resolve the outstanding audit advisories.

## 0.25.0 — 2026-08-06

### Changed
- **Numeric selectors now follow the active-session list.** `babysit list`
  numbers every row, and `babysit open N` opens that global row from any
  directory instead of using a current-directory ordinal.

## 0.24.1 — 2026-08-06

### Changed
- **Active-session tables prioritize readable metadata.** `babysit list` and
  numbered `babysit open` tables align name, status, agent, ID, and session
  columns in that order.

## 0.24.0 — 2026-08-04

### ✨ Added
- **Bare `babysit resume` now lists persistent session history.** The table
  shows names, agents, workspaces, start times, Babysit IDs, and captured native
  Codex/Claude session IDs, with the newest launches first.

### 🐛 Fixed
- **Repeated native session IDs resolve to the latest Babysit launch.** Resumed
  conversations now restore the newest saved workspace and launch settings.
- **Explicit-agent resumes retain dependency preflight checks.** Only the local
  bare-resume history listing skips Docker and tmux checks.
- **Null legacy timestamps display as unknown.** Session history no longer
  renders missing dates as the Unix epoch.

## 0.23.0 — 2026-08-04

### ✨ Added
- **Active sessions can have human-readable names.** Start one with
  `babysit <agent> --name "feature 1"`; `babysit list` shows the name and
  `babysit open "feature 1"` reattaches by exact name. Names survive resume.
- **Current-directory session choices are numbered.** When `babysit open`
  finds several active sessions, it prints numbered rows that can be selected
  with `babysit open N`.

## 0.22.0 — 2026-08-01

### Changed
- **Claude and Codex now use the current frontier defaults.** Claude remains on
  `--model best --effort max`, selecting Fable 5 where available and otherwise
  the latest Opus. Codex now launches with `--model gpt-5.6-sol` and
  `model_reasoning_effort="xhigh"`; GPT-5.6's deeper `max` effort stays opt-in.

## 0.21.0 — 2026-07-08

### ✨ Added
- **`babysit open` can infer the current workspace session.** Run it without
  an id to attach to the only active session for the current directory, or see
  matching sessions when several are active.

## 0.20.0 — 2026-07-07

### ✨ Added
- **`~/.babysitrc` can define agent environment variables.** When the host file
  exists, Babysit mounts it read-only into the container and sources it as the
  coding-agent user before launch, exporting both `KEY=value` and
  `export KEY=value` assignments.

## 0.19.0 — 2026-07-06

### Changed
- **Claude now defaults to the strongest available model.** Babysit launches
  Claude with `--model best --effort max`, selecting Fable 5 where available
  and otherwise the latest Opus.
- **Codex max defaults were re-verified.** Babysit continues to launch Codex
  with `--model gpt-5.5` and `model_reasoning_effort="xhigh"`.

## 0.18.0 — 2026-06-28

### ✨ Added
- **`babysit config` configures startup auth checks.** Choose checked agents
  with `--auth-check-agents`; defaults are Codex and Claude.

### Changed
- **Startup auth checks now use configured agents.** Babysit no longer selects
  agents from active/recent auth evidence.

## 0.17.0 — 2026-06-28

### ✨ Added
- **`--port` publishes container ports.** Use `--port 663:12345` to map a host
  port to a different container port, or `--port 80` to map the same port on
  both sides.

## 0.16.0 — 2026-06-28

### ✨ Added
- **LOOP.md can reuse the startup prompt.** Put `%initial_prompt%` in
  `LOOP.md` to paste the configured `config.initial_prompt` as part of a loop
  segment.

## 0.15.6 — 2026-06-28

### 🐛 Fixed
- **Startup now fails before tmux when Docker is not reachable.** Babysit
  checks the Docker daemon before creating a session, so stopped Docker
  Desktop prints the real connection error instead of tmux `no sessions`.
- **Fast container exits now show startup output.** Babysit captures a
  short-lived tmux diagnostic log during launch and prints it when the agent
  exits before attach.

## 0.15.5 — 2026-06-22

### 🐛 Fixed
- **Startup auth checks now use Babysit's Dockerized agent CLIs.** Babysit
  mounts credentials first, probes the agent inside the image, and avoids host
  agent binaries for auth validation.
- **Nested Docker sessions skip container-only GitHub CLI config binds.** Babysit
  still passes extracted `gh` tokens through, but avoids mounting paths the host
  Docker daemon cannot see.
- **Timed-out auth probes now reap their Docker containers.** Babysit removes
  the named probe container after the SIGTERM grace window.

## 0.15.4 — 2026-06-22

### 🐛 Fixed
- **`--docker` now works on macOS without the `/var/run/docker.sock` symlink.**
  Babysit resolves Docker Desktop's user socket, `DOCKER_HOST`, or the active
  Docker context before launching the agent container.

## 0.15.3 — 2026-06-12

### 🐛 Fixed
- **Startup auth checks now use the requested boot copy.** Babysit prints
  `Checking agent auth status...` before host agent auth checks run.

## 0.15.2 — 2026-06-12

### 🐛 Fixed
- **Startup auth checks now skip unused legacy agents.** Babysit always checks
  the requested agent, but checks other agents only when they have recent auth
  evidence or a recent successful auth-check cache entry.

## 0.15.1 — 2026-06-10

### 🐛 Fixed
- **Host auth boot checks now show which agents are being checked.** Babysit
  prints `Checking authentication status for claude, codex, gemini, opencode`
  and keeps those checks launched as a parallel batch.

## 0.15.0 — 2026-06-09

### ✨ Added
- **Startup now verifies host agent authentication before Docker launch.**
  Babysit calls Claude, Codex, Gemini, and OpenCode with a tiny `ok` prompt
  and asks whether to exit if any host agent cannot answer.

## 0.14.3 — 2026-06-08

### 🐛 Fixed
- **Host `gh` authentication now works inside Babysit containers.** Babysit
  now mounts the host GitHub CLI config read-only and passes the active host
  `gh auth token` into the container as the appropriate GitHub token env var.

## 0.14.2 — 2026-06-07

### 🐛 Fixed
- **`babysit codex` no longer trips Codex's nested bubblewrap sandbox.**
  Non-YOLO Codex sessions now disable only Codex's internal sandbox while
  preserving approvals; Docker remains the outer isolation boundary.

## 0.14.1 — 2026-06-07

### 🐛 Fixed
- **`babysit codex` no longer exits immediately with `no sessions`.**
  Codex credential and shared-instruction mounts now prepare or seed nested
  files inside the writable `CODEX_HOME` tmpdir before Docker starts.

## 0.14.0 — 2026-05-27

### ✨ Added
- **Active sessions now receive credentials for every supported agent.**
  A Codex session can invoke Claude, Gemini, or OpenCode inside the Babysit
  container using the host credentials for those tools, and the monitor keeps
  every mounted credential tmpfile synced back to the host.

## 0.13.3 — 2026-05-17

### 🐛 Fixed
- **Codex loop prompts now submit instead of becoming multiline drafts.**
  Babysit now bracket-pastes every automated prompt before pressing Enter, so
  Codex's paste-burst heuristic does not turn the submit key into a newline.

## 0.13.2 — 2026-05-06

### 🐛 Fixed
- **`babysit resume` now preserves native session state for every agent.**
  Codex, Gemini, and OpenCode now get persistent resume-state volumes like
  Claude already did, and Codex/OpenCode session ids are captured more reliably.
- **Explicit `babysit <agent> resume <id>` handles Babysit ids safely.**
  Stored metadata ids now restore the original workspace and translate to the
  agent-native id before invoking the agent CLI.

## 0.13.1 — 2026-05-06

### 🐛 Fixed
- **Claude startup prompts now wait for the TUI before pasting.** This stops
  `babysit claude --yolo` from echoing the launch prompt multiple times during
  Claude startup.

## 0.13.0 — 2026-05-06

### ✨ Added
- **Repeatable Docker/tmux E2E protocol.** `npm run test:e2e` now builds a
  fake-agent Babysit image and drives real tmux/Docker sessions through
  startup prompts, monitor rules, logging, nested Docker, mount modes,
  dependency isolation, and credential sync.

### 🐛 Fixed
- **Nested Docker bind mounts now remap every `/workspace` source.** Credential
  tmpfiles, injected config dirs, globals, and loop-deadline mounts now use
  `BABYSIT_HOST_WORKSPACE` path mapping when they live under `/workspace`, not
  only the primary workspace mount.

## 0.12.2 — 2026-05-05

### 🐛 Fixed
- **Codex startup prompts no longer render duplicated or partially submitted.**
  Babysit now waits for Codex's TUI before sending the launch prompt and
  pastes multi-line prompts through tmux bracketed paste.

## 0.12.1 — 2026-05-05

### 🐛 Fixed
- **Legacy `babysit.yaml` files receive the startup prompt again.** Existing
  configs that omit `config.initial_prompt` now fall back to Babysit's
  generated launch prompt, while explicit `null` or `""` still disables
  startup prompt typing.

## 0.12.0 — 2026-05-05

### ✨ Added
- **`--docker` enables Docker-outside-of-Docker sessions.** Babysit now mounts
  the host Docker socket, sets `DOCKER_HOST`, exports `BABYSIT_HOST_WORKSPACE`
  for nested Babysit bind mounts, and installs Docker CLI/buildx/compose
  tooling in the agent image.
- **`--docker --sandbox` and `--docker --mudbox` now warn before launch.**
  These combinations are allowed, but outside YOLO they require an explicit
  `Y` because Docker socket access can bypass the modes' filesystem
  expectations through sibling containers.

## 0.11.2 — 2026-05-05

### 🐛 Fixed
- **`babysit resume <id>` no longer passes Babysit timestamp ids to agents.**
  When no native agent session id was captured, Babysit now resumes the latest
  agent session from the original workspace instead of sending the metadata id
  to the agent CLI.
- **Resumed sessions no longer receive the startup prompt as a new message.**
  The configured `initial_prompt` still applies to fresh starts, but resume now
  reopens existing context cleanly.

## 0.11.1 — 2026-05-05

### 🐛 Fixed
- **Docker image builds no longer fail while installing `just`.** Babysit now
  installs `just` from upstream multi-arch release assets instead of relying on
  apt package availability in the slim Node base image.

## 0.11.0 — 2026-05-05

### ✨ Added
- **Babysit containers now include more agent-friendly project tooling.** Added
  Bun, Corepack shims for pnpm/yarn, nvm, pip/pipx, just, file, and explicit
  findutils coverage, with Dockerfile smoke checks for the new commands.

## 0.10.1 — 2026-05-05

### 🐛 Fixed
- **`config.initial_prompt: null` now sends no startup prompt.** Fresh
  `babysit.yaml` files include Babysit's generated default prompt directly,
  so `null` or `""` can be used as explicit opt-out values.

## 0.10.0 — 2026-05-05

### ✨ Changed
- **Initial prompt delivery is now uniform across all agents, including Claude.**
  Babysit no longer passes its launch prompt through Claude's
  `--append-system-prompt` or other agents' prompt CLI flags. Instead,
  `config.initial_prompt` in `babysit.yaml` is typed into the tmux pane after
  the agent starts.

## 0.9.9 — 2026-05-04

### ✨ Added
- **Babysit now keeps macOS awake while sessions are active.** The detached
  monitor starts `caffeinate -dimsu -w <pid>` on macOS and stops it when the
  supervised tmux session ends, so long-running agents are not interrupted by
  system sleep after you detach.

## 0.9.8 — 2026-05-04

### 🐛 Fixed
- **Changing Codex's default model inside a Babysit container no longer fails
  to persist `config.toml`.** Babysit now mounts Codex's injected config as a
  writable temp `CODEX_HOME` directory instead of bind-mounting
  `config.toml` as a single file, so Codex's atomic write-and-rename persist
  path works. Auth and `AGENTS.md` mounts are layered into that directory
  afterward.
- **Codex now defaults to extra-high reasoning effort.** The default
  `model_reasoning_effort` override changed from `high` to `xhigh`, matching
  the highest Codex effort level.

## 0.9.7 — 2026-05-03

### 🐛 Fixed
- **Docker image builds now fail when required CLI installs fail.** Agent and
  uv installers no longer mask errors; the image uses shell `pipefail` and a
  final `command -v` gate for expected tools.

## 0.9.6 — 2026-05-03

### 🐛 Fixed
- **Babysit container images now include `rg` on arm64.** The Dockerfile
  installs `ripgrep` through Debian apt instead of guessing an upstream
  `${ARCH}.deb` release asset that only exists for amd64.

## 0.9.5 — 2026-05-03

### 🐛 Fixed
- **`babysit codex --yolo` now respects host `CODEX_HOME`.**
  Codex auth/config capture reads `${CODEX_HOME}` when set instead of always
  copying `~/.codex`, preventing stale auth mounts for users who keep Codex
  state in another directory such as `~/.agents`.

## 0.9.4 — 2026-05-03

### 🐛 Fixed
- **`babysit codex --yolo` no longer loses fast startup token refreshes.**
  The monitor now receives safe credential capture hashes from the foreground,
  so a Codex refresh that happens before monitor sync starts is written back to
  host `~/.codex/auth.json` instead of being overwritten by the stale host copy.

## 0.9.3 — 2026-05-03

### ✨ Changed
- **Dead-session resume hint is now triple-click selectable.** Old: ``To resume this session, run `babysit resume <id>` `` (single line, command wrapped in backticks). New: `To resume this session, run:` followed by the bare `babysit resume <id>` on its own unquoted line — same pattern the live-session `babysit open` hint already uses, so a triple-click selects the command cleanly for paste. SPECIFICATION.md and PLAN.md updated to match.

## 0.9.2 — 2026-05-03

### 🐛 Fixed
- **`babysit codex` (and gemini/opencode) no longer fails with "refresh token was already used"** on first launch — for real this time. The 0.8.0 fix established `start_credential_sync` as bidirectional, but the monitor daemon was silently neutralising it: `cmd_monitor` called `setup_credentials(agent)` with no options, which made `copy_host_file_to_tmpfile` mint a brand-new tmpfile (the path bakes in `Date.now()`). The container kept writing OAuth refreshes to the foreground's tmpfile, while the monitor's sync watched its own — so nothing ever propagated back to the host's `~/.codex/auth.json`. Fix: `setup_credentials` now accepts `{ existing_tmpfile }`, and `cmd_monitor` passes `session.creds_tmpfile` so its sync watches the same file the container is mounting. Darwin's keychain check is preserved verbatim so the keychain-vs-fallback-file branch decision still routes correctly. Regression test in `tests/credentials_setup.test.js`. Users with already-invalidated host tokens still need a one-time re-auth (`codex auth login` etc.).

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
