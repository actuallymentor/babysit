# Babysit — Implementation Plan

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
