# Babysit — Implementation Plan

> **Historical document.** This records the initial implementation plan and is
> not current operating guidance. Use README.md, SPEC.md, the test suite, and
> the implementation itself for the present behavior.

## 2026-08-22 — Credential-independent OpenCode CI

Intent: make OpenCode command/auth tests deterministic on clean GitHub runners
without weakening provider-aware behavior on authenticated hosts.

1. Reproduce the workflow under a private credential-free `HOME` and capture
   every failing assertion.
2. Trace which tests accidentally inherit local OpenRouter evidence and make
   provider/model inputs explicit at the narrowest test boundary.
3. Cover both credential-backed fallback and credential-free deferred routing;
   do not change production defaults merely to satisfy host-specific assertions.
4. Run focused clean-home tests, the full suite, E2E, lint, build, and mandatory
   reviews. Bump the patch release if test corrections expose a shipped defect.

Outcome: Build & Release #55 contained two failed assertions plus the job-exit
annotation. Bun retained the process-start home despite in-process `HOME`
mutation, so developer credentials masked both tests. Tests now inject explicit
model intent or assert only native resume arguments, with provider fallback kept
at its existing filesystem seam. The release workflow now runs its cheap
version/tag gate on every main push, allowing a test-only follow-up to retry an
untagged failed release. No production or version change was required.

## 2026-08-22 — Prompt session-close latency

Intent: make `/exit` close the attached window promptly after Babysit prints
the reattach hint, without weakening detached credential recovery or touching
unrelated sessions.

1. Distinguish the `Detached. Re-attach with` and `To resume this session` paths,
   then measure hint-to-process-exit separately from the earlier marker, tmux,
   Docker, and monitor phases.
2. Reproduce the foreground handle leak under a real PTY. Auth progress resumes
   a fresh TTY whose initial `readableFlowing` state is `null`; restoring only an
   explicitly paused stream leaves that TTY active after the resume hint.
3. Restore stdin according to whether it was already flowing. Preserve raw mode,
   Enter/Ctrl+C handling, the random exit marker, final credential pull, recovery
   retention, and detached cleanup.
4. Add regression coverage for fresh, paused, and already-flowing TTY input. Run
   focused tests, the full suite, lint, build, and an isolated PTY process-exit
   flow without enumerating, attaching to, or closing other Babysit sessions.
5. Update public documentation/versioning if behavior changes, commit in YOLO
   mode, then request an independent post-commit review.

## 2026-08-21 — Bundled Chrome and Puppeteer

Intent: give every coding agent a ready-to-use, multi-arch Puppeteer browser
without duplicating browser downloads or weakening Chrome's sandbox.

1. Install the latest Google Chrome Stable from Google's signed Debian
   repository, whose current package indexes were verified for both amd64 and
   arm64, and expose one stable executable path to Puppeteer.
2. Install the latest `puppeteer` package in the same global npm layer as Codex
   and Gemini; set image-wide download/executable configuration so project-local
   installs also reuse Chrome instead of downloading another browser.
3. Make the global package resolvable from both CommonJS and ESM workspace
   scripts, verify commands/imports statically in the Dockerfile, and exercise
   a real non-root browser launch in native-architecture Docker testing.
4. Pass an explicit workflow refresh stamp before the browser/agent layers so
   scheduled builds bypass stale BuildKit cache; give browser processes ample
   shared memory, allow Chrome's sandbox namespace setup through a minimally
   extended, private launch-scoped Docker seccomp profile without granting
   `SYS_ADMIN`; require Docker to acknowledge container creation before deleting
   that profile, reap only Babysit-generated create attempts on cancellation,
   and document that `babysit update` pulls this refreshed toolset.
5. Update user-facing docs, changelog/version metadata, and persistent notes;
   run lint, focused/full tests, a real image build, and an actual page load.

## 2026-08-19 — Active-session flags column

Intent: make each active session's launch mode immediately visible in both
`babysit list` and `babysit list --all`.

1. Format stored session modifiers as a compact comma-separated value, with
   `-` for sessions that have no recorded flags or no stored metadata.
2. Add an opt-in renderer column after `AGENT`; enable it for `babysit list`
   with and without `--all`, while keeping shared `babysit open` tables compact.
   `--all` remains responsible only for diagnostic ID and raw tmux columns.
3. Cover default, verbose, unflagged, legacy, and shared compact rows in
   focused tests, updating existing header and alignment assertions.
4. Update help text, README.md, SPECIFICATION.md, CHANGELOG.md, package version
   (v0.29.0), lockfiles, and persistent notes.
5. Verify lint, focused and full tests, build output, and the real CLI table.

## 2026-08-18 — Active-session list format refresh

Intent: make the default active-session table compact and human-readable while
keeping diagnostics available through `babysit list --all`.

1. Parse `--all` as a list-only display flag and pass the parsed command into
   `cmd_list`. Preserve `--all` as agent passthrough outside the list command.
2. Render compact rows as `#`, `NAME`, `STATUS`, `TMUX`, `AGENT`, and
   `DIRECTORY`. Fall back from an absent name to the native/canonical session
   ID, and shorten the stored working directory to its deepest two levels.
3. Add `ID` and full `SESSION` columns in verbose mode. Keep shared tables used
   by `babysit open` compact except where duplicate names require IDs.
4. Publish `running`/`idle` transitions from the existing monitor
   `IdleTracker` into a per-session tmux user option. Initialize new sessions
   as `running`; treat legacy sessions without the option as `running`.
5. Update parser, renderer, monitor, tmux integration, help, README,
   specification, changelog, and focused tests. Verify lint, focused tests,
   full tests, build, and real CLI output before committing.

### 2026-08-18 correction — viewport activity

`STATUS` describes visible tmux activity, not the timeout used by idle
supervision rules. Keep the existing pane-output hash tracker, report `running`
whenever the captured viewport changes, then report `idle` after one complete
one-second monitor interval without a change. Leave `idle_timeout_s` and
per-rule timeouts untouched for automation and the statusline deadline.

## Context

`babysit` is a CLI supervisor for LLM coding agent CLIs (`claude`, `codex`, `gemini`, `opencode`). It is the JS-based, multi-agent successor to [sir-claudius](https://github.com/actuallymentor/sir-claudius), which was a bash + Python tool wrapping only Claude Code. The new tool addresses three gaps in sir-claudius:

1. **Multi-agent support** — sir-claudius hard-codes Claude. Babysit abstracts each agent behind an adapter so claude/codex/gemini/opencode get the same supervisor experience.
2. **Configurable supervision** — sir-claudius's `auto-accept.py` patterns are hard-coded. Babysit reads `babysit.yaml` so users define `on/do` rules per project (idle/plan/choice/literal/regex → command/string/markdown).
3. **Cleaner internals** — Move from 2,490-line bash + 765-line Python PTY wrapper to a single bun-compiled JS binary that uses tmux for session management instead of a custom PTY.

The intended outcome is a single static binary the user installs once, then runs against any of the four supported agents in any of three autonomy modes (`sandbox`/`mudbox`/`yolo`), with declarative supervision rules per project and the same docker isolation lessons sir-claudius accumulated.

## Tech stack

- **Runtime**: Node.js 24 LTS, written in plain JavaScript (no TypeScript) per user `tooling-preferences.md`
- **Build**: `bun build --compile --target=...` to produce static binaries for `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`
- **Lint**: `airier` scaffold (`curl -o- https://raw.githubusercontent.com/actuallymentor/airier/main/quickstart.sh | bash`)
- **Utility lib**: `mentie` — `log`, `cache`, `promise_timeout`, `make_retryable`, `throttle_and_retry`
- **YAML**: `yaml` (Eemeli Aro's package — round-trips comments, supports custom tags)
- **CLI parsing**: `mri` (tiny, supports unknown args passthrough — required by spec for "unknown flags pass to coding agent")
- **Tmux**: `child_process.spawn` directly (no wrapper — clearest control)
- **Docker**: shell out to `docker` CLI
- **Embedded assets**: `import x from './x.yaml' with { type: 'file' }` for `babysit.default.yaml`, `Dockerfile`, `entrypoint.sh`, `statusline.sh`, system-prompt fragments
- **Style**: snake_case everywhere, no semicolons, space-in-brackets, `log.*` not `console.*`, JSDoc on every exported fn, gitmoji commits

## Repository layout

```
babysit/
├── package.json                 # bun build scripts, version, deps
├── .nvmrc                       # 24
├── .agentignore                 # mark sensitive paths off-limits
├── .notes/                      # per-CLAUDE.md persistent memory
│   ├── MEMORY.md                # index
│   ├── GOTCHAS.md               # accumulated pitfalls
│   ├── RESEARCH.md              # findings on each agent CLI
│   └── TIMELINE.md              # decision log
├── src/
│   ├── index.js                 # entry: parse argv, dispatch subcommand
│   ├── cli/
│   │   ├── parse.js             # mri wrapper, mode/agent extraction, passthrough
│   │   ├── help.js              # `babysit --help`
│   │   ├── start.js             # `babysit <agent> [args]`  (default verb)
│   │   ├── list.js              # `babysit list`
│   │   ├── open.js              # `babysit open <session_id>`
│   │   └── resume.js            # `babysit resume <session_id>`
│   ├── agents/
│   │   ├── index.js             # registry: name → adapter
│   │   ├── claude.js            # Claude Code adapter
│   │   ├── codex.js             # OpenAI Codex adapter
│   │   ├── gemini.js            # Gemini CLI adapter
│   │   └── opencode.js          # opencode adapter
│   ├── patterns/
│   │   ├── index.js             # patterns.js — { agent: { plan, choice } }
│   │   ├── claude.js
│   │   ├── codex.js
│   │   ├── gemini.js
│   │   └── opencode.js
│   ├── babysit/
│   │   ├── yaml.js              # load/parse babysit.yaml + write defaults
│   │   ├── monitor.js           # tmux capture-pane → match → action loop
│   │   ├── matcher.js           # idle / plan / choice / literal / /regex/
│   │   ├── actions.js           # action executor (cmd | string | .md w/ ===)
│   │   ├── timeout.js           # parse SS / MM:SS / HH:MM:SS
│   │   └── segments.js          # split string/markdown by `===` lines
│   ├── tmux/
│   │   ├── session.js           # new-session, has-session, kill, attach
│   │   ├── capture.js           # capture-pane -p with retry/timeout
│   │   └── send.js              # send-keys w/ Enter / C-c / Escape helpers
│   ├── docker/
│   │   ├── run.js               # build `docker run` argv from agent + flags
│   │   ├── volumes.js           # node_modules / .venv hash-volume isolation
│   │   ├── update.js            # pull latest image
│   │   └── assets/
│   │       ├── Dockerfile       # container image (embedded)
│   │       ├── entrypoint.sh    # container entrypoint (embedded)
│   │       └── statusline.sh    # claude-only statusline (embedded)
│   ├── credentials/
│   │   ├── index.js             # detect platform → load adapter
│   │   ├── darwin.js            # Keychain (security cli) + sync daemon
│   │   ├── linux.js             # ~/.config/<agent>/auth.* + sync daemon
│   │   └── refresh.js           # in-place hash-guarded update (never `mv`)
│   ├── modes/
│   │   ├── yolo.js              # --yolo: skip-perms + sys-prompt append + env
│   │   ├── sandbox.js           # --sandbox: no workspace mount
│   │   ├── mudbox.js            # --mudbox: workspace :ro
│   │   └── loop.js              # --loop: override `on: idle`
│   ├── system_prompt/
│   │   ├── base.md              # base prompt (embedded)
│   │   ├── yolo.md              # appended in yolo
│   │   ├── sandbox.md           # appended in sandbox
│   │   └── mudbox.md            # appended in mudbox
│   ├── statusline/
│   │   └── render.js            # statusline string builder
│   ├── deps/
│   │   ├── check.js             # docker/tmux/git presence
│   │   └── selfupdate.js        # git pull repo + ~/.agents + docker pull
│   ├── sessions/
│   │   ├── store.js             # ~/.babysit/sessions/<id>.json
│   │   └── extract.js           # capture session id from agent output
│   └── utils/
│       ├── log.js               # mentie log re-export with prefix
│       ├── platform.js          # darwin / linux / wsl detect
│       └── paths.js             # ~/.babysit, /tmp/babysit-*
├── scripts/
│   ├── install.sh               # cross-platform installer
│   ├── build.sh                 # bun build for all targets
│   └── release.sh               # zip + checksum release artifacts
├── babysit.default.yaml         # template written on first run
├── .github/
│   └── workflows/
│       ├── publish.yml          # build + release on package.json version bump
│       └── docker.yml           # build + push container image
├── tests/
│   ├── yaml.test.js             # default file shape, parsing, segments
│   ├── matcher.test.js          # idle/plan/choice/literal/regex
│   ├── timeout.test.js          # SS / MM:SS / HH:MM:SS parser
│   ├── tmux.test.js             # session create/capture/send (integration)
│   └── agents.test.js           # adapter shape per agent
├── CHANGELOG.md
├── README.md
└── LICENSE
```

## Core abstractions

### Agent adapter shape (`src/agents/<name>.js`)

```js
export const claude = {
    name: 'claude',
    bin: 'claude',                                      // command on PATH
    install_check: async () => { /* version probe */ },
    credentials: {
        darwin: { keychain_service: 'Claude Code-credentials',
                  fallback_file: '~/.claude/.credentials.json' },
        linux: { file: '~/.claude/.credentials.json' }
    },
    container_paths: {                                  // mount targets
        creds: '/home/node/.claude/.credentials.json',
        config: '/home/node/.claude/settings.json'
    },
    flags: {
        skip_permissions: () => '--dangerously-skip-permissions',
        append_system_prompt: ( text ) => [ '--append-system-prompt', text ],
        resume: ( id ) => [ '--resume', id ],
        model: ( m ) => [ '--model', m ],
        effort: ( e ) => [ '--effort', e ]
    },
    defaults: { model: 'opus', effort: 'max' },
    session_id_pattern: /Session: ([0-9a-f-]{36})/,     // capture from output
    extra_env: ( mode ) => ( { DISABLE_AUTOUPDATER: '1' } )
}
```

`codex`, `gemini`, `opencode` follow the same shape. Skipping a capability (e.g. opencode's `effort`) just omits the flag fn. Resume mechanics differ per agent (`-r`, `exec resume --last`, `--resume latest`, `--session`); each adapter encapsulates its own.

### Pattern table (`src/patterns/<name>.js`)

```js
export const claude = {
    plan: [
        /needs your approval/i,
        /Do you want to proceed\?/i
    ],
    choice: [
        /\(esc to interrupt\)/,
        /\? for shortcuts/
    ]
}
```

These are derived from sir-claudius `auto-accept.py` PLAN_TRIGGERS for claude; gemini/codex/opencode patterns will be filled in by manual probing during phase 2 — `.notes/RESEARCH.md` will track findings.

### `babysit.yaml` shape

Default file matches the spec literally (commented and uncommented examples for `idle`, `plan`, `choice`, regex). The parser:

1. Reads `config.idle_timeout_s` (default 300), `config.commands` (named bash snippets), `config.lines_for_literal_match` (10), `config.lines_for_regex_match` (10), `config.isolate_dependencies` (true).
2. Iterates `babysit:` array in order — first match wins.
3. `on:` parser:
   - `idle` → idle_timer ≥ timeout
   - `plan` → match against `patterns/<agent>.js#plan`
   - `choice` → match against `patterns/<agent>.js#choice`
   - quoted string → literal match in last N lines
   - `/.../<flags>` → regex match in last N lines
4. `do:` parser:
   - bare word → look up `config.commands[word]`; if found run shell snippet, else send literal keystroke
   - quoted string → send literal + Enter
   - `*.md` path → load file, split by `===`, send each segment; between segments, wait for idle
5. `timeout:` parser handles `SS`, `MM:SS`, `HH:MM:SS` and overrides per-rule.

### Tmux orchestration

Session naming follows the spec: `babysit_$(pwd)_<agent>_<timestamp>`. Long paths are SHA-256-hashed if `>200` chars (sir-claudius lesson). Each session uses its own socket via `-L babysit`. Properties applied right after `new-session`:

```
set-option -g history-limit 10000
set-option -g mouse on
```

Monitor loop (in `babysit/monitor.js`):

1. `tmux -L babysit capture-pane -p -t <session>` every 1s (configurable)
2. Hash the strip-ansi'd output → if unchanged for `idle_timeout_s`, fire `on: idle`
3. Otherwise scan last N lines against active rules in `babysit:` order; first match → execute `do`
4. After firing, debounce 3s before re-evaluating same rule (sir-claudius lesson: redraw flicker double-fires)

Pattern matching strips ANSI **after** mapping `\x1b[nC` (cursor-forward) → space — direct lift from sir-claudius v0.8.1 fix.

### Credential passthrough (per-platform)

Two-phase auth (sir-claudius v0.8.2 lesson, replicated):

1. **Detect** — without reading secrets: `security find-generic-password -s <service>` on darwin (no `-w`); file `test -f` on linux.
2. **Pre-flight** — run a no-op probe of the host CLI (`claude -p "ok"`, `codex --version`, etc.) so any token rotation happens *before* capture.
3. **Capture** — read into a `mktemp` file, mode 0666 (so container UID can read).
4. **Sync daemon** — background `setInterval` (300s) re-reads source, hashes, `printf > tmpfile` in-place if changed. Never `mv` (sir-claudius v0.15.0 lesson — Docker bind mounts track inodes).

The daemon PID is tracked in `~/.babysit/sessions/<id>.json` and killed on session exit (use `disown` semantics — sir-claudius v0.15.1 — to avoid "Terminated" message on stderr).

### Docker container

Single image: `babysit/babysit:<version>`. Built from `src/docker/assets/Dockerfile`:

- Base: `node:24-slim`
- System: `git curl jq yq fzf ripgrep fd-find bat scc shellcheck htop strace lsof procps tmux openssl gpg python3 uv build-essential`
- All four agent CLIs preinstalled (`claude`, `codex`, `gemini`, `opencode`)
- User: `node` with passwordless sudo (`/etc/sudoers.d/node`)
- `ENV NPM_CONFIG_PREFIX=/home/node/.npm-global`
- `ENV PATH=/home/node/.npm-global/bin:$PATH`
- `ENV GIT_AUTHOR_NAME=Babysitter`, `GIT_COMMITTER_NAME=Babysitter` (per spec; user override via host env passthrough)
- `WORKDIR /workspace`
- Entrypoint thin: drop creds-permissions fix, `chown` `/workspace/node_modules` if isolated, symlink `~/.agents/skills` into `~/.claude/skills` if present, then `exec` agent

### Mode flags → docker invocation

| Flag | Mount strategy | Sys-prompt appendix | Env |
|---|---|---|---|
| (none) | `$(pwd):/workspace` rw | base | — |
| `--yolo` | `$(pwd):/workspace` rw | base + yolo.md | `AGENT_AUTONOMY_MODE=yolo` + skip-perms flag |
| `--sandbox` | (none — ephemeral) | base + sandbox.md | — |
| `--mudbox` | `$(pwd):/workspace:ro` | base + mudbox.md | — |
| `--loop` | (additive) | (no sys-prompt change) | overrides `on: idle` rule |

Always-on mounts: `~/.agents:/home/node/.agents:ro`, `~/.babysit/sessions:/home/node/.babysit/sessions`. Conditional on agent: each adapter's `container_paths` + creds tmpfile.

For `config.isolate_dependencies: true` (default): when host workspace contains `package.json`/`requirements.txt`/`pyproject.toml`/`Pipfile`, add `-v babysit-nm-<sha256(pwd)[:12]>:/workspace/node_modules` and `-v babysit-venv-<hash>:/workspace/.venv`.

### Subcommands

- `babysit list` — `tmux -L babysit list-sessions -F '#{session_name}\t#{?session_attached,attached,detached}\t#{session_created}'` filtered to `^babysit_`. Cross-references `~/.babysit/sessions/*.json` to print agent name + session id.
- `babysit open <id>` — `exec tmux -L babysit attach -t <session>`. `<id>` is the babysit session id (path-encoded), looked up in `~/.babysit/sessions/`.
- `babysit resume <id>` — load `~/.babysit/sessions/<id>.json`, cd to recorded `pwd`, re-exec `babysit <agent>` with the agent's resume flag injected.

### Self-update preflight

Every command (after arg parse, before docker run):

1. `git -C <babysit_repo> pull --quiet` if `.git` exists in install dir
2. `git -C ~/.agents pull --quiet` if exists
3. `docker pull babysit/babysit:latest` (cached unless `--no-update`)

These run in parallel via `Promise.all` with `promise_timeout(5000)` — slow network shouldn't block.

### Session id capture

After `docker run` is dispatched, monitor loop watches the pane for `session_id_pattern` per agent. On match, write `~/.babysit/sessions/<babysit_id>.json`:

```json
{
    "babysit_id": "20260428-110000-abcd",
    "agent": "claude",
    "agent_session_id": "abc-123-...",
    "tmux_session": "babysit_-workspace_claude_20260428-110000",
    "pwd": "/home/user/myrepo",
    "modifiers": [ "yolo" ],
    "creds_tmpfile": "/tmp/babysit-creds-XXXX",
    "creds_sync_pid": 12345,
    "started_at": "2026-04-28T11:00:00Z"
}
```

On session exit (detected by `tmux has-session` returning non-zero), print `To resume this session, run:` then `babysit resume <agent_session_id>` on its own line (unquoted, so it's triple-click selectable).

### Statusline

Implemented for Claude only at first (only Claude consumes a statusline). Renders via `statusline.sh` that pulls:

- `$BABYSIT_MODIFIERS` env (e.g. `yolo·loop`)
- `git remote get-url origin` → `owner/repo`
- `git rev-parse --abbrev-ref HEAD` → branch
- Loop deadline from `/tmp/babysit-loop-deadline-<id>` (mm:ss countdown)

No usage tracking — sir-claudius's claude.ai/api scraping is fragile; spec says "without the usage logic".

## Implementation phases

### Phase 1 — Scaffolding (≈1 day)
- `npm init`, install `mentie yaml mri`, run `airier` quickstart, add `.nvmrc`, `.agentignore`
- `bun build --compile` smoke test for all four targets
- `src/utils/log.js`, `src/utils/paths.js`, `src/utils/platform.js`
- `.notes/` populated with `MEMORY.md`, `GOTCHAS.md` (preseed sir-claudius gotchas), `RESEARCH.md` (preseed agent CLI table)

### Phase 2 — babysit.yaml (≈1 day)
- `babysit/yaml.js` — load/save with defaults
- `babysit/timeout.js` — `SS|MM:SS|HH:MM:SS`
- `babysit/segments.js` — split-by-`===` for both inline strings and markdown
- `babysit.default.yaml` matching spec's literal example, embedded via bun import attribute
- Tests: `tests/yaml.test.js`, `tests/timeout.test.js`

### Phase 3 — Tmux + matcher (≈2 days)
- `tmux/session.js` — new/has/list/kill (using `-L babysit` socket, `set-option` for history/mouse)
- `tmux/capture.js` — capture-pane with `promise_timeout`
- `tmux/send.js` — send-keys including `Enter`, `C-c`, `Escape`, `\x1b[Z`
- `babysit/matcher.js` — strip-ANSI (with cursor-forward fix), idle hash-tracking, last-N-lines slice, regex/literal/keyword dispatch
- `babysit/monitor.js` — tick loop, debounce, rule iteration
- `babysit/actions.js` — execute `do:` (command | literal | markdown segments)
- Tests: `tests/matcher.test.js`, integration `tests/tmux.test.js` (skipped if tmux missing)

### Phase 4 — Docker assets (≈2 days)
- `docker/assets/Dockerfile` — based on sir-claudius's, expanded with codex/gemini/opencode installs and fzf
- `docker/assets/entrypoint.sh` — chown/exec
- `docker/assets/AGENTS.md` — content lifted/updated from sir-claudius's CONTAINER_AGENTS.md
- `docker/run.js` — argv builder, mode-aware mounts
- `docker/volumes.js` — hash-volume detection from project signals
- `docker/update.js` — `docker pull`
- Local build script `scripts/build.sh` runs `docker buildx build --platform linux/amd64,linux/arm64`

### Phase 5 — Agent adapters + patterns (≈2 days)
- `agents/claude.js`, `agents/codex.js`, `agents/gemini.js`, `agents/opencode.js`
- `patterns/<agent>.js` — seeded with public docs + sir-claudius for claude; manually probed for the others (write findings to `.notes/RESEARCH.md`)
- `agents/index.js` registry
- Per-agent flag tables verified against latest official docs (refetch in CI weekly)
- Tests: `tests/agents.test.js` checks adapter shape conformance

### Phase 6 — Credentials + modes (≈2 days)
- `credentials/darwin.js`, `credentials/linux.js`, `credentials/refresh.js`
- `credentials/index.js` per-agent dispatch
- `modes/yolo.js`, `modes/sandbox.js`, `modes/mudbox.js`, `modes/loop.js`
- `system_prompt/*.md` embedded; concatenation pipeline for active modifiers
- Background sync daemon launched as detached child via `child_process.spawn` with `detached: true; stdio: 'ignore'; unref()`

### Phase 7 — CLI + subcommands (≈1 day)
- `cli/parse.js` — mri with allowlist of known flags; rest passes through to agent argv
- `cli/start.js` (default), `cli/list.js`, `cli/open.js`, `cli/resume.js`, `cli/help.js`
- `index.js` dispatcher
- Self-update preflight via `deps/selfupdate.js`
- `deps/check.js` — verify docker, tmux, git on PATH

### Phase 8 — Statusline + sessions (≈1 day)
- `statusline/render.js` + embedded `statusline.sh`
- `sessions/store.js`, `sessions/extract.js`
- "To resume" exit message
- Loop deadline file for statusline countdown

### Phase 9 — Install + release (≈1 day)
- `scripts/install.sh` — detect OS+arch, fetch latest binary from GitHub releases, drop into `/usr/local/bin` (mac/linux), prompt for missing deps with package-manager hints
- `.github/workflows/publish.yml` — on `package.json` version change: `bun build` × 4 targets → release with checksums
- `.github/workflows/docker.yml` — daily + on Dockerfile change: `docker buildx build --push --platform linux/amd64,linux/arm64`

### Phase 10 — Polish (≈1 day)
- README with usage/examples
- CHANGELOG (gitmoji format)
- `.notes/MEMORY.md` final pass
- End-to-end manual test for all four agents × three modes

Total: ≈14 working days for first releasable cut.

## Critical files to be created (top of priority)

- `src/index.js`, `src/cli/parse.js` — entry & dispatch
- `src/babysit/yaml.js`, `src/babysit/matcher.js`, `src/babysit/monitor.js`, `src/babysit/actions.js` — supervision core
- `src/agents/{claude,codex,gemini,opencode}.js` — adapters
- `src/patterns/{claude,codex,gemini,opencode}.js` — detection regexes
- `src/docker/run.js` + `src/docker/assets/Dockerfile` — sandbox
- `src/credentials/{darwin,linux,refresh}.js` — auth passthrough
- `babysit.default.yaml` — first-run template (matches spec literally)
- `scripts/install.sh`, `.github/workflows/publish.yml` — distribution

## Reused existing utilities

- `mentie.log` — replaces all `console.*` (per `js-style.md`)
- `mentie.cache` — last-output hash for idle detection
- `mentie.promise_timeout` — wraps every `tmux capture-pane` and `docker` call
- `mentie.make_retryable` — transient tmux/docker command failures
- `mentie.throttle_and_retry` — parallel agent ops if we ever support multi-spawn
- `airier` lint scaffold — drives all style decisions per user prefs

## Gotchas to bake in upfront (from sir-claudius lessons)

1. Two-phase OAuth (detect → pre-flight → capture) — **avoids token-refresh race**
2. `printf > file` not `mv` for credential sync — **Docker inode tracking**
3. `\x1b[nC` cursor-forward → space *before* ANSI strip — **pattern matching reliability**
4. Hash long tmux session names (>200 chars) — **tmux name limit**
5. 3s debounce after auto-accept — **redraw flicker double-fire**
6. `disown` on the sync daemon — **suppress "Terminated" on exit**
7. Hash-named docker volumes for `node_modules`/`.venv` — **cross-platform binary mismatch**
8. Plan acceptance for claude is `\x1b[Z` (Shift+Tab), not Enter — **post-v2.1 UI**

All eight tracked in `.notes/GOTCHAS.md` from day one.

## Verification

End-to-end smoke test for each combination:

```bash
# Verify build
bun build --compile --target=bun-linux-x64 ./src/index.js --outfile dist/babysit-linux-x64
./dist/babysit-linux-x64 --version

# Default-yaml generation
cd /tmp/empty && /path/to/babysit claude
# → expect babysit.yaml created matching spec

# Each mode (need creds for one agent at minimum)
babysit claude --yolo                       # rw mount, yolo prompt, skip-perms
babysit codex --sandbox --loop              # no mount, loop overrides idle
babysit gemini --mudbox --yolo              # ro mount, yolo prompt
babysit opencode resume <id> --yolo         # resume + yolo

# Subcommands
babysit list                                # shows active tmux sessions
babysit open <id>                           # attaches
# detach (Ctrl-b d), babysit list still shows it
# exit agent, expect "To resume..." line

# Pattern matching
# - Edit babysit.yaml: add `- on: "test-string"`, `do: "echo hello"`
# - Inside session, type "test-string", expect babysit injects "echo hello"
# - Add `- on: /\bbug\b/i`, `do: "rg --no-heading bug"`
# - Type "Bug here", expect rg ran

# Credential refresh
# - Run yolo session, leave running > 5min on macOS, observe creds tmpfile mtime updates
# - Confirm container can still call agent (no auth failures)

# Self-update preflight
babysit claude --no-update                  # skip check
BABYSIT_DEBUG=1 babysit claude              # log shows git pulls + docker pull
```

Test suite (run via `npm test` → bun test):

- `tests/yaml.test.js` — default file shape, custom `commands`, segment splitting, timeout parsing
- `tests/matcher.test.js` — idle (hash unchanged), plan/choice (regex), literal, regex flags
- `tests/timeout.test.js` — `30`, `01:30`, `01:01:30`
- `tests/agents.test.js` — every adapter exposes the required surface
- `tests/tmux.test.js` — integration; skipped if tmux missing on CI

CI matrix (in `.github/workflows/test.yml`): ubuntu-latest + macos-latest, node 24, run unit tests + a docker-less subset (mock the `docker` and `tmux` calls behind `src/utils/exec.js` so the matcher/yaml/agents tests don't need either).

## What is intentionally out of scope for v1

- Worktree mode (sir-claudius has it; spec doesn't mention it; can ship in v1.1)
- Statusline usage scraping (spec says "without the usage logic")
- Auto-update tokens via Pushover or other notification channels (only `notify_command` in default config — user wires it)
- WSL-specific credential paths (linux adapter is best-effort for WSL; flag if user asks)
- Windows native (bun supports it but the docker/tmux assumptions don't — defer)
- Worktree-style branch isolation (no spec ask)

These each become a separate phase if/when requested.

---

## 2026-08-20 — Reliable OpenCode initial prompt and fast/skippable startup

Status: implementation authorized on 2026-08-20. Implement the selected A/A/A policy below and commit after verification.

### Intent

1. Make Babysit's configured `initial_prompt` arrive in a real OpenCode session exactly once, after the TUI can accept input.
2. Measure and reduce the time between invoking `babysit <agent>` and reaching the main agent TUI.
3. Let an interactive user skip slow authentication probes without leaking credentials, leaving probe containers behind, or turning a skip into an authentication failure.
4. Find the measured cause of the recurring 10–30 second delay when closing a Babysit session, then remove avoidable shutdown latency without weakening credential recovery or container cleanup.

Scope boundary: Gemini currently has the same missing-ready-pattern risk, but this task targets OpenCode as requested. Reuse the capture/fixture workflow for Gemini in a separate follow-up rather than silently expanding this implementation.

### Current evidence

- Babysit does not pass `initial_prompt` to OpenCode's command. It starts the container, then pastes the prompt into the tmux pane and presses Enter.
- Codex and Claude declare ready-screen patterns. OpenCode declares none, so `wait_for_initial_prompt_ready()` returns immediately after Docker reports the container running. That is a real startup race.
- Resumes deliberately do not send the initial prompt again. Preserve this behavior.
- Startup does not auto-update or auto-pull anymore. Normal startup latency is therefore elsewhere.
- Credential setup stages credentials for every supported agent. Linux file credentials and the macOS Claude Keychain path currently execute host `<agent> --version` preflights serially; macOS file-backed credentials do not. Existing research says the preflight is useful for Claude but a no-op for Codex, Gemini, and OpenCode.
- Startup authentication checks default to Codex and Claude, regardless of the agent being launched. They run concurrently, but each check creates a separate Docker container, stages credentials, makes a real model request, flushes any rotated credential, and removes the container. Each probe can wait up to 90 seconds.
- Authentication probes can rotate OAuth credentials. A skipped probe must be cancelled and finalized safely; it must never be abandoned in the background.

### Selected startup policy

The 2026-08-20 implementation authorization selects the recommended options:

- **Authentication:** active agent + 12-hour success cache (1A).
- **Enter during a probe:** skip this launch only, then wait for safe cleanup (2A).
- **Non-interactive cache miss:** skip with a warning (3A).
- **Doctor selection:** `babysit doctor --auth` checks all supported agents by default; an explicit agent narrows it, and `--refresh` bypasses cache.

The alternatives below remain as decision history.

### Previously considered alternatives

#### 1. Default authentication policy

- **A — Active agent + cache (recommended):** check only the agent being launched; reuse a successful result while its credential fingerprint is unchanged and the result is younger than 12 hours. `babysit doctor --auth` checks all agents on demand.
- **B — Configured agents + cache:** retain the current configured-agent set, but reuse fresh successful results. This preserves cross-agent/subagent assurance at the cost of more cache-miss work.
- **C — Manual only:** remove model-backed authentication probes from normal startup. `babysit doctor --auth` becomes the only real probe path; the launched CLI surfaces its own authentication failure.

#### 2. What Enter means during a live probe

- **A — Skip this launch only (recommended):** cancel outstanding probes, finish credential recovery/cleanup, and continue startup. Persistent policy changes remain explicit through `babysit config`.
- **B — Snooze:** cancel and suppress new probes for one hour.
- **C — Disable persistently:** cancel and set auth checks to `none`. This is fastest but makes an accidental Enter change durable configuration.

#### 3. Non-interactive behavior on a cache miss

- **A — Skip with warning (recommended):** CI/scripts never wait for a model-backed probe; `babysit doctor --auth` remains available when verification is required.
- **B — Bounded advisory check:** run probes for at most 10 seconds, then continue with a warning.
- **C — Fail closed (current behavior):** retain blocking checks; a failed check prints the prompt and exits because non-TTY input cannot answer it. Options A and B intentionally change current CI/script semantics.

### Success criteria

#### OpenCode prompt delivery

- A new OpenCode launch records the configured initial prompt as its first submitted user message exactly once.
- The prompt is not echoed, partially submitted, or split at embedded newlines.
- Cold image-cache and warm starts behave identically.
- Normal and `--yolo` launches work; resumes receive no new initial prompt.
- A changed or unsupported OpenCode ready screen times out with a clear diagnostic instead of silently sending early.

#### Startup latency

- Every major startup phase has debug timing, allowing latency attribution without guesswork.
- Warm starts with a valid auth cache perform no model-backed probe.
- Pressing Enter during live probes produces visible acknowledgement immediately and advances only after credential-safe cleanup completes.
- Interactive auth checks show a compact live indicator with elapsed time and per-agent state; redirected/non-interactive output remains stable plain text.
- Skipped/cancelled checks never trigger the later `Unauthenticated agents ... Exit?` prompt.
- No orphan auth-check containers, credential tmpfiles, raw-mode stdin state, keypress listeners, or refresh-token regressions remain.
- An ordinary in-session OAuth rotation preserves a still-trusted fresh cache entry; a host-side re-login, credential replacement, or failed final flush invalidates it.

#### Shutdown latency

- Debug timing identifies where the recurring 10–30 second close delay is spent: agent exit, tmux teardown, container stop, credential final pull, recovery bookkeeping, or polling/backoff.
- A normal interactive close releases the foreground promptly after agent exit; mandatory credential and container finalization then completes in the detached owner without a fixed foreground grace period.
- Ctrl+C, agent-requested exit, tmux detach/kill, Docker failure, and forced termination converge on one idempotent cleanup path.
- Faster close never drops a rotated credential, removes a recovery-retained container, or leaves a session/container/monitor orphaned.

### Phase 1 — Establish real baselines

1. Record end-to-end startup timings over at least five cold and five warm launches using `BABYSIT_DEBUG=1` where credentials are available; use the fake-agent Docker fixture for repeatable credential-free baselines.
2. Add temporary or permanent debug timers around:
   - dependency checks;
   - Docker daemon and Watchtower inspection;
   - credential discovery and each agent preflight;
   - each auth probe's Docker preparation, model response, credential pull, and cleanup;
   - main container preparation/start;
   - TUI readiness and initial-prompt submission.
3. Compare three auth configurations: `none`, one agent, and current defaults (`codex,claude`). Capture median and slowest observed duration.
4. Verify the suspected cause before changing policy. Keep any optimization whose measured impact is material; reject speculative complexity.

### Phase 2 — Discover OpenCode's real ready screen

1. With Docker access, build or select the same image Babysit actually launches and record the in-container `opencode --version`.
2. Create a disposable workspace with `initial_prompt: null` so Babysit cannot race the observation.
3. Capture the visible tmux pane every 100–250 ms through cold and warm starts. Store sanitized, secret-free loading and ready snapshots as test fixtures.
4. Prove the composer accepts input at the candidate boundary without making a model request:
   - paste a unique sentinel without Enter;
   - confirm it appears in the composer;
   - clear it before submission;
   - repeat across several launches.
5. Select the narrowest stable text that:
   - is present after ANSI normalization;
   - appears only when the composer accepts input;
   - does not depend on workspace path, account, model, version patch, or terminal redraw timing;
   - is absent from loading, login, provider-selection, and error screens.
6. Prefer a ready-screen regex in `src/agents/opencode.js`. Evaluate native `opencode --prompt` only as a fallback if no stable marker exists; command-line prompt delivery exposes the prompt through container command metadata and changes cross-agent behavior.

### Phase 3 — Implement and verify OpenCode readiness

1. Add `initial_prompt_ready_pattern` to the OpenCode adapter with a comment tied to the captured screen invariant.
2. Add prompt-readiness unit cases using the real sanitized fixtures:
   - loading screens do not match;
   - ready screens match;
   - ANSI-decorated ready screens match after normalization;
   - login/error screens do not match;
   - repeated checks remain deterministic.
3. Extend Docker E2E coverage with a deterministic fake OpenCode-ready fixture, then add an explicit environment-gated real OpenCode launch in a disposable workspace. The real case submits a harmless minimal prompt and verifies it exists once in the native OpenCode session/transcript; it never runs in normal CI or on credential-less machines.
4. Repeat for cold/warm and normal/`--yolo`; verify resume still suppresses initial-prompt injection.
5. Run the app like a user: attach to tmux, observe the prompt submission, receive a minimal response, detach, and resume.

### Phase 4 — Make auth probes observable and cancellable

1. Introduce an auth-check run controller with an external `AbortSignal` and explicit result states: `authenticated`, `unauthenticated`, `skipped`, and `cancelled`/`failed` as needed. Do not overload `authenticated: false` for user skips.
2. Thread cancellation through both stages:
   - Docker create/copy preparation, which currently owns only an internal abort controller;
   - the running agent child and its SIGTERM → grace period → SIGKILL path.
3. Preserve credential correctness on cancellation:
   - stop the probe agent;
   - pull only that probe's credential after any possible token rotation;
   - if final pull fails, retain the stopped container and recovery metadata exactly as current recovery rules require;
   - otherwise remove the container and ephemeral transports;
   - wait for all probe finalizers before starting the main container.
4. Add a TTY-only keypress guard around the aggregate probe operation:
   - display `Checking authentication: codex, claude — press Enter to skip`;
   - recognize Enter only, while preserving Ctrl+C termination semantics;
   - recognize raw `\x03` explicitly and invoke the normal termination path, because raw mode prevents the terminal driver from delivering SIGINT automatically;
   - acknowledge `Skipping authentication checks; cleaning up...` immediately;
   - restore raw mode and remove listeners in `finally`, including spawn errors and signals;
   - complete that teardown before any readline-based genuine-auth-failure prompt starts;
   - never install key listeners for non-TTY input.
5. Add a terminal progress renderer shared by the auth controller:
   - render one compact TTY line with a spinner, total elapsed time, the Enter hint, and per-agent states such as `codex ⠋`, `claude ✓`, `opencode ✗`, and `gemini skipped`;
   - expose meaningful phases (`preparing`, `checking`, `recovering credentials`, `done`) so a slow cleanup does not look hung;
   - repaint in place without flooding scrollback, and stop/unref the timer on every completion, skip, error, and signal path;
   - suspend and clear the live line before warnings, readline prompts, stack traces, or tmux attachment, then render a final one-line summary;
   - respect `NO_COLOR`, `TERM=dumb`, Unicode capability, and non-TTY output by using plain milestone lines with no cursor control or animation;
   - keep animation output free of credential values, model responses, and Docker command details;
   - make the renderer own output only; the keypress guard continues to own stdin so spinner updates cannot consume Enter or Ctrl+C.
6. Keep existing concurrent probe execution. Parallelization already exists and is not the missing optimization.
7. Filter skipped results before failure logging, unauthenticated-agent confirmation, and credential-abort handling so Enter always continues once cleanup is safe. Update the genuine failure prompt so it no longer claims startup selection comes from `babysit config`.

### Phase 5 — Apply the selected authentication policy

#### If option 1A or 1B uses caching

1. Store cache metadata under `~/.babysit/`, never in project configuration or session records.
2. Cache only safe metadata: agent name, successful-check timestamp, credential fingerprint, and immutable Babysit image identity. Fingerprint file, Keychain, and environment-backed credential inputs without storing their values; use the local image ID/digest rather than a mutable tag. Never store tokens or model output.
3. Compute the credential fingerprint after a successful probe's final credential pull, because the probe itself may rotate the token.
4. On macOS, derive Claude's fingerprint from the current Keychain credential value and persist only its hash; do not assume every provider has a credential file.
5. Invalidate on an untrusted credential change, auth failure, image change, explicit `babysit doctor --auth --refresh`, or TTL expiry.
6. A successful session final flush may re-stamp the cached fingerprint only when the pre-launch fingerprint matched a fresh successful cache entry and the final credential recovery completed. This preserves trust across normal OAuth token rotation without blessing a concurrent host re-login or a failed/retained recovery.
7. Cache successes only. Never cache failure, skip, timeout, interrupted cleanup, or a credential whose final state could not be fingerprinted.

#### If option 1A checks only the active agent

1. Migrate startup selection to the launched agent.
2. Normal startup ignores the legacy configured list. `babysit doctor --auth` checks all supported agents by default, and `babysit doctor --auth <agent>` narrows the selection. Keep reading old config files without error, but deprecate the configured list and remove its startup-facing prompt/help claims.

#### If option 1C is manual-only

1. Add `babysit doctor --auth [agent|all]` using the existing probe implementation.
2. Normal startup performs credential presence/staging only and lets the actual agent report authentication errors.

### Phase 6 — Remove measurable non-probe delay

1. Replace unconditional credential-file `<agent> --version` calls with an adapter-declared preflight capability.
2. Retain the preflight only where it changes credential state or avoids a known first-request failure—currently Claude according to project research.
3. Do not stop staging other agent credentials; cross-agent credentials inside the container are an existing feature and separate from whether their host CLIs need a no-op preflight.
4. Re-measure Docker daemon/Watchtower inspection and staged credential copies. Optimize only phases that remain material after auth changes.
5. Do not reintroduce automatic updates or image pulls into startup.

### Phase 7 — Diagnose and remove slow session close

1. Reproduce the 10–30 second close delay through the real CLI in Docker and record at least five runs for each available exit path: the agent's normal exit command, Ctrl+C, tmux session close, container-side failure, and agent exit while the user is detached.
2. Measure two separate timelines with a shared session correlation ID:
   - foreground-visible close: agent/container process exit → `docker start -ai` exit → tmux session disappearance → `tmux attach` return → final CLI output → Node event-loop drain/process exit;
   - detached cleanup: monitor death detection → credential final pull → container stop/remove → recovery-marker updates → monitor exit.
3. Trace every shutdown timeout, retry interval, and serial finalizer. Prove which wait accounts for the observed delay before changing it; retain timings useful under `BABYSIT_DEBUG=1`.
4. Replace fixed sleeps or coarse polling with event/process completion where possible. Run independent safe finalizers concurrently, while keeping credential pull before container removal and preserving recovery retention on pull failure.
5. Make shutdown ownership explicit and idempotent so signals, the foreground waiter, tmux teardown, and monitor cleanup cannot each pay the same grace period or finalization cost. Do not make foreground return wait on detached credential cleanup unless measurements prove that cleanup already blocks the tmux/Docker boundary.
6. Add deterministic tests with fake clocks/processes for fast normal exit, required SIGTERM-to-SIGKILL escalation, already-exited children, Docker stop/remove failures, credential-pull retention, and competing cleanup callers.
7. Re-run real Docker close measurements after the fix. Record median and slowest before/after values and verify zero leftover Babysit containers, tmux sessions, credential tmpfiles, or recovery markers.

### Expected file changes

- `src/agents/opencode.js` — real ready-screen regex.
- `src/cli/start.js` — phase timing, skip UX integration, selected auth policy.
- `src/index.js` and `src/deps/check.js` — dependency/dispatch timing plus `doctor` routing.
- `src/agents/auth.js` — cancellable probe controller, explicit result states, per-probe timing.
- Optional new `src/cli/progress.js` — reusable TTY spinner/progress renderer with plain-output fallback.
- `src/docker/launch.js` — safe external cancellation during Docker create/copy/start.
- `src/credentials/{index,linux,darwin}.js` and agent adapters — declared preflight behavior and post-probe fingerprint handoff.
- `src/babysit/config.js`, `src/cli/config.js`, `src/cli/parse.js`, `src/cli/help.js` — selected policy, TTL/doctor settings, and compatibility migration.
- Optional new `src/cli/doctor.js` and auth-cache module under `src/agents/` or `src/credentials/`.
- Sanitized OpenCode readiness fixtures and a small timing helper/test seam.
- Shutdown owners discovered during Phase 7, expected among `src/cli/start.js`, `src/docker/launch.js`, `src/babysit/monitor.js`, and tmux/session helpers.
- `tests/prompt.test.js`, `tests/agent_auth.test.js`, `tests/config.test.js`, parser/help tests, Docker launch tests, and real E2E coverage.
- `README.md`, `CHANGELOG.md`, and persistent gotcha/research notes after implementation.

### Required tests

#### Unit and integration

- OpenCode loading/ready/error fixture classification.
- OpenCode readiness timeout does not send the prompt and emits the clear diagnostic.
- Enter before Docker preparation, during create/copy, during model execution, and during final credential pull.
- SIGTERM/SIGKILL escalation and close/timeout/skip race determinism.
- Credential pull success, pull failure retention, source-wins host re-login, and cleanup idempotence.
- Skipped results continue without the unauthenticated confirmation.
- TTY listener/raw-mode restoration on every exit path; non-TTY never reads stdin.
- Spinner frame/state rendering with a fake clock, final-line cleanup, `NO_COLOR`/`TERM=dumb` fallback, redirected output, and no timer/listener leaks.
- Cache hit, TTL expiry, credential-fingerprint change, agent/image version change, and corrupt-cache fallback.
- Trusted session-end token rotation re-stamps a fresh matching cache entry; host re-login and failed final recovery do not.
- `doctor --auth` parse/dispatch, all/default and single-agent selection, `--refresh` bypass, and success-only cache writes.
- Existing concurrent-start guarantee remains.

#### Real user-path E2E

- Real OpenCode cold/warm prompt submission and resume behavior.
- Slow fake auth agent: press Enter through a PTY, verify quick acknowledgement, safe completion, and zero leftover probe containers.
- Slow fake auth agent through a real PTY: verify animated phase changes, per-agent completion marks, a clean final summary, and no corrupted follow-up prompt.
- Manual/opt-in, environment-gated real credential-backed probe with minimal output to verify cancellation does not invalidate the next launch. Never run it in normal CI or on credential-less machines.
- Timing comparison before/after under no-auth, cache-hit, cache-miss, and manual-skip paths.
- Real close timing comparison across normal exit, Ctrl+C, tmux close, and forced container exit, with post-run orphan checks.

### Documentation and rollout

1. Explain that authentication probes make real model requests and may rotate credentials.
2. Document the selected default, Enter behavior, non-TTY behavior, cache TTL/invalidation, and `babysit doctor --auth` usage.
3. Update `README.md`, `SPECIFICATION.md`, help text, and the configuration examples together.
4. Preserve old `~/.babysit/config.json` compatibility; missing new fields receive the selected defaults.
5. Update `CHANGELOG.md`, bump the package version, and synchronize both lockfiles because startup authentication semantics are user-visible.
6. Update persistent gotchas for external cancellation plus credential-finalization ordering.
7. Run reflect, style, changelog, tests, cleanup, commit the authorized implementation, then run the post-commit independent review.

### Implementation outcome — 2026-08-20

Status: complete.

- OpenCode 1.18.15 was observed in the real Babysit image. `Ask anything...` is the verified composer boundary; provider, authentication, and invalid-model overlays are rejected. Sanitized captures now lock that behavior in tests.
- Normal startup checks only the active agent. Successful checks use a 12-hour hash-only credential/image cache; Enter cooperatively cancels a live probe, and non-interactive cache misses warn and continue. `babysit doctor --auth [agent|all] [--refresh]` owns explicit checks.
- Host credential preflight is adapter-declared and remains enabled only for Claude. Startup/auth/Docker/tmux phases print elapsed timings under `BABYSIT_DEBUG=1`.
- Close-delay tracing separated agent exit from Docker and monitor cleanup. The fake agent exited in about 32 ms, but Moby 28.3.3 kept `docker start -ai` open for another 3.5–4.9 seconds while completing bounded stream/logger/task cleanup; the daemon's 2/10/30-second internal waits explain the reported 10–30-second tail under load. Credential final pull starts after tmux death and was not the foreground cause.
- Interactive containers now run through a signal-forwarding entrypoint supervisor. It emits a randomized per-session exit marker as soon as the agent child is reaped. The monitor validates the token and closes tmux immediately, then waits for Docker's copy-safe stopped state before the final credential pull and container removal.
- Before the fix, three direct close measurements were 4.576–4.940 seconds. The hardened real-Docker E2E measured nine natural closes at 277–1,056 ms, with zero labeled containers, private credential directories, or recovery markers left behind.
- Unit/integration coverage includes cancellation before Docker create, during copy, during the agent process, and during final credential pull; TTY restoration; cache invalidation/rotation; shutdown marker forgery; stopped-state polling; and cleanup idempotence. The full fake-agent Docker E2E covers all four adapters, prompt submission, exact-once resume behavior, credential rotation, sandbox, mudbox, and nested Docker.

## 2026-08-21 — Credential-check startup latency diagnosis

Intent: explain why session startup credential checks are slow for every
supported coding agent (`claude`, `codex`, `gemini`, `opencode`) and propose
targeted mitigations without changing behavior.

1. Map the startup/auth-check path, agent adapters, cache, Docker lifecycle,
   credential staging/recovery, GitHub auth capture, and concurrency boundaries.
2. Attribute latency separately to all-agent credential setup, cache lookup and
   miss reasons, Docker create/copy/start/remove, agent CLI boot, first output,
   model completion, and final credential recovery.
3. Build a per-agent matrix covering credential backend, copied inputs, probe
   command, cacheability, agent-specific startup work, causes, confidence, and
   mitigations. Separate behavior-preserving optimizations from lower-assurance
   or policy-changing alternatives.
4. Reproduce cold, warm, success, failure, and cancellation paths with safe
   fakes for all four agents; use opt-in real runs only where credentials are
   already available without reading ignored files. Include native Linux vs
   Docker Desktop and macOS Keychain distinctions when evidence permits.
5. Verify relevant CLI/auth and Docker behavior against current primary
   documentation. Test status commands and startup-disabling flags as
   candidates, not as behavior-equivalent assumptions.
6. Ask an independent coding agent to challenge the plan and diagnosis, then
   rank causes and mitigations by expected impact, safety, and effort.

## 2026-08-21 — Reliable initial-prompt submission

Intent: ensure Codex, Claude, and OpenCode receive `config.initial_prompt`
exactly once as a submitted message, never as an unsubmitted composer newline.

1. Trace readiness detection, tmux bracketed paste, Enter delivery, startup
   timing, session logging, and fake/real E2E coverage for all three agents.
2. Capture current agent versions and real ready screens without reading
   ignored credentials. Prove whether each readiness marker denotes an active
   composer, and reproduce the paste-to-submit race repeatedly.
3. Replace banner-only readiness or immediate post-paste Enter behavior where
   evidence shows a race. Keep prompts out of Docker command metadata, preserve
   embedded newlines as one composer value, retry transient pane-capture errors
   within an absolute deadline, and retain no-prompt-on-resume.
4. Add deterministic PTY/tmux regression coverage that models asynchronous
   bracketed-paste processing. Make fake submissions append-only, then assert
   exact multiline contents, one submission, and no prompt left in the composer.
5. Run focused tests, full tests, lint, and real user-path launches for Codex,
   Claude, and OpenCode. Verify native transcript/session state where available,
   exercise resume suppression for each agent, and check sessions, containers,
   buffers, and temp files for orphans after success and failure paths.
6. Update user-facing docs, changelog/version, and persistent notes in line with
   the verified behavior, then run independent review before and after commit.

Outcome: Claude and Codex now require their usable composer footer and reject
startup blockers; OpenCode retains its validated composer gate. All automated
text waits 150 ms after bracketed paste before sending Enter once. A delayed-
composer Docker/tmux matrix submitted the exact prompt once for every adapter
without any early input; the unit suite covers transient capture failures and
the monotonic readiness deadline.

## 2026-08-21 — Faster all-agent authentication without weaker assurance

Intent: guarantee prompt-level authentication for every supported coding agent
before starting any session, while removing avoidable serial and unrelated work.

1. Preserve the strongest check: each uncached Claude, Codex, Gemini, and
   OpenCode result must come from a successful real model response in Babysit's
   Docker image. Keep credential refresh recovery, selected provider/config,
   `.babysitrc`, and failure confirmation semantics intact.
2. Capture independent agent credentials concurrently. Retain Claude's
   preflight-before-capture ordering, add a hard bound to host preflight
   commands, and preserve active-agent-first result ordering and monitor sync.
   Move blocking command primitives to the bounded async runner first; merely
   wrapping synchronous capture in `Promise.all` is not concurrency.
3. Replace active-only startup verification with all-supported-agent cache
   lookup and concurrent misses. Resolve the immutable image identity once,
   run uncached checks in non-interactive launches too, cache successes only,
   and keep Enter as an explicit cooperative override in interactive launches.
4. Give each probe only its own credential descriptors. Continue staging all
   credentials into the real session so agents can invoke one another, but do
   not copy unrelated secrets into four throwaway probe containers. Use one
   shared selector for probe staging and cache fingerprinting. Preserve every
   auth-relevant shared input and per-agent provider/account setting; never
   infer that an agent is unconfigured from missing tracked credentials because
   `.babysitrc`, provider helpers, and cloud metadata can authenticate it.
5. Track source replacement and cache trust per agent. Refresh or invalidate
   each verified cache independently after foreground and detached credential
   finalization; one agent's host login must not evict every other warm result.
   Store `auth_cache_contexts` keyed by agent with legacy singular-field reads,
   expose per-name source-change state, and fingerprint effective `.babysitrc`
   plus generated provider/account config so a cache hit covers the probe's
   complete auth input.
6. Bound the entire probe lifecycle, including Docker preparation, model call,
   credential recovery, and cleanup. A timeout may fail closed or retain
   recoverable state; it must never be recorded as authenticated.
7. Add timing and behavior tests for concurrent capture/checks, per-probe mount
   filtering, cache hit/miss ordering, non-TTY verification, per-agent token
   rotation/source replacement, lifecycle timeout, and zero leftover probe
   resources. Run focused, full, lint, build, and real fake-agent Docker paths.
8. Update README/config/help/specification, changelog/version, and persistent
   notes. Run independent reviews before implementation and after commit.

Policy decisions from independent review:

- Probe all four agents on every cache miss, even without a tracked file/env.
  Real inference is the guarantee; local credential presence is not.
- Non-interactive misses run and fail closed. Interactive Enter remains an
  explicit user override, never an automatic assurance downgrade.
- Keep `.babysitrc` and route/account config. Do not use `--bare`,
  `--ignore-user-config`, `--pure`, fixed models, or other profile changes that
  would verify a different route than the real session.
- Keep isolated per-agent probe containers in this patch. A shared multi-exec
  container could reduce Docker floor further, but changes entrypoint/config
  semantics enough to require separate measurement and design.

## 2026-08-21 — Startup regression corrections

Intent: remove the prompt/auth regressions introduced by v0.30.1–v0.31.0 while
keeping model-backed verification and credential recovery intact.

1. Replace Codex's optional banner/footer readiness conjunction with its stable
   empty-composer marker plus existing startup blockers. Cover footer-collapsed,
   banner-scrolled, loading, and blocker screens; audit Claude's equivalent gate
   without broadening this fix beyond evidence.
2. Select startup auth agents as the active frontend plus non-active supported
   CLIs that resolve on the host PATH. Keep active-first ordering, injectable
   detection, cache behavior, and `doctor --auth all` semantics.
3. Make an Enter skip apply to the entire startup auth decision: cancel pending
   probes safely, finish credential recovery, surface the batch-level skip to
   startup, and continue without a second `Exit? [Y/n]` prompt caused by
   failures that completed before Enter.
4. Give OpenCode probes the same effective model as the real session, including
   `--model` passthrough and the `openai/gpt-5.6-sol` adapter default. Add only
   a generated tool-free auth agent, fingerprint the effective model for cache
   invalidation, and distinguish credential failures from generic probe/model
   failures in user-facing diagnostics. Do not import a host config that the
   real session itself does not stage.
5. Add focused unit/integration coverage, real Docker/tmux user-path checks for
   Codex prompt delivery and OpenCode probe command/output, and orphan cleanup
   assertions. Update docs, changelog, version, and persistent notes.
6. Run lint, focused tests, full tests, E2E, build, reflect/style review, and an
   independent post-commit review. Release target: v0.31.1.

## 2026-08-22 — OpenCode authentication diagnosis

1. Reproduce `babysit doctor --auth opencode --refresh` with redacted combined diagnostics and compare the effective provider/model to credential provider keys.
2. Trace staged credential and route-profile transport, including environment paths that could redirect OpenCode's data/config homes.
3. Fix the smallest root cause and cover provider mismatch, explicit model overrides, and result classification.
4. Verify both doctor and startup production paths, then run the post-edit checklist and independent review.

## 2026-08-22 — OpenCode server-error follow-up

1. Preserve every existing Babysit tmux session and container. Use only read-only
   inspection plus uniquely named disposable probe containers created by this
   diagnosis; never invoke global cleanup, session close, or broad Docker removal.
   Hash the shared host OpenCode credential file before and after wrapped probes;
   direct comparison probes use a private read-only copy and never the live file.
2. Reproduce the reported `UnknownError` against the source resolver and capture
   the effective provider/model, OpenCode version, sanitized route, and provider
   response classification without printing credential values. Record the host
   Babysit version and immutable image id too. If the exact host binary is outside
   this environment, give the user one redacted debug command. Enable verified
   OpenCode debug logging and recover only diagnosis-owned logs before cleanup.
3. Compare a direct OpenCode request, the tool-free auth profile, and Babysit's
   wrapped probe. Determine whether the error is provider/model availability,
   OpenCode server behavior, stale installed code/image, or Babysit's wrapper.
   Include same-model-without-agent, auth-agent-without-model, and known-served-
   model variants where the exact image supports the required flags.
4. Fix the narrow proven cause. The current classifier already calls this
   `failed`, not `unauthenticated`; address the startup gate with a bounded retry
   and/or explicit transient status so one provider 5xx does not hard-fail a
   non-interactive launch.
5. Add regression coverage, run real probes sequentially and with a hard bound,
   then complete full
   reflect/style/changelog/test/build review and commit without pushing.
   Existing sessions continue uninterrupted; new launches may wait on the shared
   auth-check lease while each short-lived probe owns it.
