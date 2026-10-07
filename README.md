# babysit

Durable Docker + tmux sessions for coding agents. Detach, resume, recover;
automate terminal responses with YAML rules.

Supports [Claude](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex),
[Antigravity](https://antigravity.google/docs/cli/overview/), and
[OpenCode](https://github.com/anomalyco/opencode).

## Quick start

Requires **macOS/Linux, Docker, tmux, Git**. New Linux clones also require **rsync** (`sudo apt install rsync`, or your package manager). Installs to `~/.local/bin`; no sudo.

```bash
curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash
```

```bash
babysit                                 # Interactive launcher
babysit "feature 1"                      # Launcher with session name
babysit claude --yolo
babysit codex --clone --name "feature 1"
babysit codex --sandbox --loop
babysit antigravity --mudbox
```

**Detach:** `Ctrl+B d` · **Reattach:** `babysit open` · **Reference:** `babysit --help`

Unknown flags pass through: `babysit claude --yolo --model sonnet --effort high`.
Explicit models override defaults. Codex defaults to `gpt-6-astra`, effort `medium`.
Claude defaults to `best`, effort `medium`; explicit effort flags override it.

### Launcher

| Input | Action |
|---|---|
| ↑/↓ | Navigate rows |
| ←/→ | Select agent CLI (Model) or Mode |
| Type on Name | Set session name |
| Space | Toggle Docker, YOLO, Clone, Loop |
| Enter / Esc / Ctrl+C | Launch / cancel / cancel |

Mode: Regular → Sandbox → Mudbox. Clone forces Regular.
Selections persist per workspace; new workspaces inherit the latest global selection.
Names never persist. Menu requires a TTY; explicit agent commands ignore defaults.
Use explicit commands in scripts.

## Flags

| Flag | Effect |
|---|---|
| _(none)_ | Read-write workspace mount |
| `--yolo` | Maximum autonomy; skip agent permissions (Claude: also answers the bypass-immune "Dangerous rm operation" prompt) |
| `--sandbox` | No workspace mount; ephemeral |
| `--mudbox` | Read-only workspace mount |
| `--clone` | Durable workspace clone + `/original`; explicit merge-back |
| `--docker` | Host Docker daemon access |
| `--ignore-host-agents-md` | Skip host instructions, preferences, rc file; keep credentials |
| `--port PORT` / `--port H:C` | Publish port; repeatable |
| `--loop` | Continue on idle |
| `--log[=PATH]` | Append raw tmux output to file |
| `--config FILE` | Use FILE instead of `./babysit.yaml`; the session keeps it on resume and in clones. Works with the launch menu too: `babysit --config FILE` |

Flags combine. `--clone` excludes `--sandbox` / `--mudbox`. `--docker` weakens isolation:
the socket controls the host daemon, including in Sandbox/Mudbox.

`--clone` on a repository root clones its committed state (`git clone`, no hardlinks; every branch, tag,
remote-tracking ref and remote kept) and carries untracked/ignored paths matching `config.clone.carry`
(default `.env`, `.env.*`, `.notes`, `babysit.yaml`; wholly ignored folders are carried as a unit, never walked).
Dependencies and build output are not copied; uncommitted edits are not either unless `config.clone.changes: true`
(staged and unstaged state survive; untracked files come along). `config.clone.depth: N` clones shallow history.
Plain folders, repository subdirectories, repositories declaring attribute filters (LFS, git-crypt), and
`config.clone.mode: copy` copy the working tree instead, skipping `config.clone.exclude` names (default
`node_modules`) at any depth. Submodules and nested worktrees are only present in copy mode.

```yaml
config:
    clone:
        mode: git            # git | copy
        carry: ['.env', '.env.*', '.notes', 'babysit.yaml']
        changes: false
        depth: null
        exclude: ['node_modules']
```

Linux copies preserve hard links within the clone, sparse files, timestamps, and supported ACLs/xattrs.
macOS copies clone files through APFS reflinks when available. Copies run as your user; privileged
ownership/metadata remain limited by your permissions and filesystem. Completed clone reuse/resume does not require rsync.

Copy mode preserves nested worktrees (including `.claude/worktrees`) with isolated Git metadata.
Worktree metadata must stay within the copied source; cloning a linked worktree as the root remains unsupported.
Absolute-linked worktrees are locked against Git pruning across mount paths; manage/unlock them from the host clone path.

`--clone` checks the whole source before copying. Paths you own but can't read (e.g. a `drw-------`
`__pycache__`) are listed with the exact `chmod`; answer `y` (or pass `--yes`) to apply it and retry.

## Sessions

Status: `running` for foreground work, `waiting` for Claude background shells, `idle` when ready.
Idle rules do not start while waiting; manual input remains available.

| Command | Effect |
|---|---|
| `babysit init [file.yaml]` | Write a commented default config; asks for the file name when none is given |
| `babysit list [--all] [--watch]` | Active sessions as a tree: workspace trunks, numbered leaves with colored status and container CPU/MEM, totals row; `--all` adds tmux attachment, IDs, tmux names; `--watch` redraws every 2s with full colors and hides archived sessions, numbers unchanged (external `watch` drops 256-color codes) |
| `babysit open [id\|name\|number]` | Attach |
| `babysit resume [--all]` | Workspace history; all history if none here or `--all` |
| `babysit resume <id\|number> [flags]` | Restore saved session |
| `babysit <agent> resume <id\|number> [flags]` | Restore; selected history row must match agent |
| `babysit close <number or id>` | Close by list number or ID; retire launch from recovery |
| `babysit archive <number, id or name>` | Dim the session and sink it to the bottom of its workspace; a workspace whose sessions are all archived sinks to the bottom of the list. `babysit open` un-archives |
| `babysit prune --list` | Managed clone usage |
| `babysit prune` | Interactively prune unused Docker data and managed clones |
| `babysit doctor --auth [agent] [--refresh]` | Real auth check for every installed agent; bypass 12h cache with `--refresh` |
| `babysit auth [status]` | Cached authentication ages and whether the scheduled checker is installed |
| `babysit auth check` | Quietly re-verify cached logins older than 6h; yields to a starting session |
| `babysit auth init [--remove] [--no-linger]` | Install (or remove) the hourly checker: systemd user timer on Linux (enables user lingering unless `--no-linger`), launchd agent on macOS |
| `babysit config` | Effective paths, image, socket, menu defaults, web/recovery status |
| `babysit update` | Update Babysit, agent tools, image; show image version |

Detach or agent exit shows remaining sessions. `list` samples panes for 1s:
input/interrupt controls → idle/running; Claude background shells → waiting; otherwise output stability; unreadable → unknown.
Status is grey when idle, green when running, orange when waiting, red when the agent ran `babysit stuck`
(cleared by typing into that tmux session or sending input from the web companion). CPU/MEM come from a cache each session's
monitor refreshes every 30s from `docker stats` (CPU: 100% = one core; MEM: used, whole MiB); `-` when no sample
is younger than 5 minutes. The totals row is green under 50% of the Docker host's cores/memory, yellow under 70%, red above.
Colors follow `NO_COLOR`, `TERM=dumb`, and non-TTY output.
Attachment is separate. Pruning needs free space for locks/journals.
Launch verifies only the launched agent's authentication (12h hash-bound cache); other
installed agents still receive credentials but are checked by `doctor --auth`.
Run `babysit auth init` once so an hourly host-level checker keeps verified logins warm (a launch that had to probe reminds you, and `babysit config` shows the checker state);
launches then skip the "Checking authentication" probe. The checker only refreshes agents a
launch or `doctor --auth` verified before, and leaves OpenCode (whose identity depends on the
project's provider route) to launch-time verification. Running sessions re-stamp the cache
when they rotate a token, and a launch shows which startup step it is on (`Starting claude: …`);
any step over 5s is reported by name.
Docker cleanup removes stopped containers and images not needed by this account's saved Babysit sessions, plus unused networks and build cache across the current Docker daemon. Babysit-named containers, images still used by containers, and volumes stay intact. Cleanup requires a separate confirmation. `prune --list` only lists clones.
Old resume IDs follow their latest launch; history shows current launches and saved status.

Numbers use each command's current listing:

- `open N` / `close N` / `archive N`: `babysit list` (archived rows sit at the bottom and are numbered there).
- `resume N` / `<agent> resume N`: `babysit resume`; use `resume N --all`
  for rows from `babysit resume --all` (also supported with an explicit agent).
- `recover N`: `babysit recover --dry-run`, across workspaces.

Re-list after sessions change; use IDs for durable references.

### Recovery

| Command | Effect |
|---|---|
| `babysit recover [id\|number]` | Recover interrupted sessions, detached, across workspaces |
| `babysit recover --dry-run [--json]` | Inspect candidates/blockers |
| `babysit recover --no-continue [id\|number]` | Reopen without sending continuation |
| `babysit recover init` | Enable Ubuntu boot recovery for this account |

Resumes the saved conversation, then sends: “You were interrupted. Check the current
state, then continue unfinished work.” Includes idle sessions; preserves live agents,
repairs missing monitors, avoids duplicate running sessions. Attach with `babysit open`.

| Preserved | Limits |
|---|---|
| Detach/shutdown recovery intent | Normal exit / `close` retires session |
| Model, effort, variant, modes, ports, image, credential-home paths | Credentials reloaded |
| Saved conversation | Unflushed work / in-flight subprocesses lost; Sandbox stays ephemeral |
| Supported launch configuration | Missing transcripts, changed config, unsupported args/prerequisites block recovery |

Older sessions need `resume`. Custom sockets need the same `BABYSIT_TMUX_SOCKET`.
Uncertain continuation delivery after a second crash: inspect the conversation,
then acknowledge with `--no-continue`; already-submitted input remains effective.

**Ubuntu boot recovery:** system Docker, direct Docker access, home/workspaces/credentials
available before login. Run as session owner; the command requests sudo internally.

```bash
babysit recover init
journalctl -u "babysit-recover-$(id -u).service"
sudo systemctl disable "babysit-recover-$(id -u).service" # Disable future boot recovery
```

- Enables next-boot recovery; leaves current sessions alone. Bounded retries; failures in journal.
- Stop service → suspend its sessions, preserve recovery intent. `close` → retire session.
- Captures absolute executable, PATH, `BABYSIT_HOME`; login shell settings are not loaded.
- Rerun after moving executable/storage or adding workspace mount dependencies.
- Checks storage, Docker access, Babysit, `sh`, `tmux`, `docker`, `cat`, `ps` as service user.
- Unattended init needs root or cached/passwordless sudo. Avoid a `sudo` prefix: it can strip PATH/storage exports.
- Login-unlocked homes/keyrings and rootless/remote Docker require separate host setup.

## Model and effort

Inside a newly launched managed session:

```bash
babysit model                 # Available models + top 30 coding benchmarks
babysit model <model-name>     # Switch within this agent
babysit effort                # Supported effort levels
babysit effort high
babysit model --status <id>    # Result of a queued terminal request
babysit effort --status <id>
babysit exit                  # End this session gracefully after the current turn
babysit stuck                 # Mark this session "stuck" in babysit list until the user types into it
babysit loop                  # Toggle --loop for this session; prints "Looping is now enabled/disabled"
```

`babysit exit` marks the session intentionally closed (recovery will not relaunch it), waits for the
agent's composer to be idle, sends `/exit`, and forces a close if the agent has not quit after 30 seconds.

Changes affect this session, not future launch defaults. Claude subagent calls
control the main session; they do not change the subagent's private model.
Compatible effort is preserved; switching to an incompatible model selects its
default effort.
A request already running at the provider finishes unchanged.

| Agent | Behavior |
|---|---|
| Codex | Native thread/turn settings; reports partial application if the active turn rejects a model change |
| Claude | Native session-only pickers; effort can change during a turn |
| OpenCode | Effort plugin; model picker applies on the next turn |
| Antigravity | Native model/effort controls; waits for an idle composer |

Terminal controls preserve drafts and existing dialogs, queue for up to 60 seconds,
and return a request ID while pending. `--status` reports applied/failed results.
Model catalogs and effort choices come from the installed CLI/provider.
OpenCode `effort default` restores its TUI variant; plugin overrides do not update
its footer. After a manual OpenCode model change, send a turn before querying its
API-backed model/effort state.

Requires an updated image and a new container with its host monitor running.
Remote/headless sessions, Codex `--profile`, OpenCode `--pure`: normal launch
without API controls. Codex resume/fork with permission flags uses the native CLI;
its live controls remain unavailable.

## Model benchmarks

```bash
babysit model --benchmarks                         # Coding descending, missing metrics as —
babysit model --benchmarks --sort cost --limit 20   # Cheapest intelligence task
babysit model --benchmarks --sort cost-per-point    # Cost/task ÷ intelligence
babysit model --benchmarks --json                  # Machine-readable report
```

Bare `babysit model` appends `--benchmarks --limit 30` after available models.
A missing benchmark key or API failure leaves the model list visible.

Sorts: `coding` (default), `intelligence`, `agentic`, `cost`, `cost-per-point`,
`name`. Scores descend; costs and names ascend. Missing values sort last.
`--limit N` takes a positive integer; omit for all matching rows.
Rows missing a metric still show, with `—` in that column.

Columns: model/effort variant, provider, intelligence, coding, agentic,
intelligence benchmark USD/task, USD/intelligence point. Token pricing is omitted.
A zero intelligence score has no cost/point. The ratio measures benchmark cost,
not whether a model can solve your particular task.

Requires `ARTIFICIAL_ANALYSIS_API_KEY`. Configure container defaults in `~/.babysitrc`:

```bash
export ARTIFICIAL_ANALYSIS_API_KEY="your-key"
ARTIFICIAL_ANALYSIS_TTL_MINUTES=15
```

Uses the Artificial Analysis free API, fetching all pages. Cache lives at
`~/.cache/babysit/benchmarks.json` in the existing Docker cache volume, shared
across Babysit containers on the same Docker daemon. TTL `0` bypasses caching;
invalid/negative TTLs fail. Failed refreshes use stale data with a stderr warning.
Cache failures fall back to a live fetch; hosts without `flock` use atomic writes
without refresh locking. JSON stays valid. Host invocations
use the host cache/environment; `.babysitrc` is sourced on container launch only.

Provider filtering happens on every invocation using installed CLIs and local
native credentials (Codex, Claude, Antigravity, and recognized direct OpenCode
providers). Credentials are read without refreshing tokens or sending inference.
This does not verify expired credentials or imply every listed variant is
selectable in your CLI. Router credentials alone do not enable every creator.

## Account usage

```bash
babysit usage                 # Host or container; no running session required
babysit usage --json          # Structured results, including partial failures
```

Queries authenticated agents independently. Claude/Codex show provider quota
windows and reset times; OpenRouter shows API-key budgets and spend. Unknown
allowances stay unknown. Local token history is not an account limit.

Internal provider endpoints are used where needed. Unsupported credentials/providers
(including Antigravity quota retrieval) are labeled unavailable; other results remain
visible. Exit 1 indicates unavailable usage or fetch errors. Missing authentication
is reported separately. Usage reads do not start inference.

## Supervision

`babysit init` writes a commented `babysit.yaml` (or the name you give it, used via `--config FILE`); without one, defaults apply. Rules run top-down; first match wins.

```yaml
config:
    idle_timeout_s: 300
    yolo_approve_dangerous_commands: true # false: let Claude auto-deny its rm safety prompt

babysit:
    # Uncomment wanted rules.
    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00

    # - on: /error/i
    #   do: notify_command
```

| Setting | Values |
|---|---|
| `on` | `idle`, literal text, `/regex/flags` (literal and regex look at the last 10 pane lines) |
| `do` | `enter`, named `config.commands` command, text, Markdown file |
| `timeout` | Idle rules only: `SS`, `MM:SS`, `HH:MM:SS`; overrides `idle_timeout_s` |
| Markdown steps | Separate with `===`; wait for idle between steps |
| `--loop` source | First available: `./LOOP.md` → `~/.agents/LOOP.md` → `Keep going` |

`--ignore-host-agents-md` skips the host `LOOP.md`.

## Mobile web companion

```bash
babysit web init         # Initialize bridge, print token; rerun to rotate token

# Local: http://127.0.0.1:3000
BABYSIT_WEB_UID="$(id -u)" \
BABYSIT_WEB_GID="$(id -g)" \
docker compose -f examples/compose.web.local.yml up --build -d
```

Production behind a TLS proxy:

```bash
BABYSIT_WEB_UID="$(id -u)" \
BABYSIT_WEB_GID="$(id -g)" \
BABYSIT_WEB_PROXY_NETWORK="proxy" \
BABYSIT_WEB_PUBLIC_ORIGIN="https://babysit.example.com" \
docker compose -f examples/compose.web.yml up -d
```

- Proxy → `http://babysit-web:3000` on shared network; no published host port.
- Preserve original host, `X-Forwarded-Proto`, `X-Forwarded-For`.
- Keep bridge directory private. Companion gets sanitized state + request queue; no Docker/tmux/home/workspace access.
- Custom bridge: same absolute `BABYSIT_WEB_BRIDGE_DIR` for Babysit and Compose.
- Running sessions discover newly initialized bridges. After upgrades, exit/resume old sessions to load updated monitor/capture helpers; first new reply fills the view.

| Control / indicator | Meaning |
|---|---|
| Message view | Latest completed reply; retained while busy |
| Terminal output | Live tool steps/prompts |
| Reply ↓ | Jump to composer; draft while busy, send when unlocked |
| Copy | Copy code block |
| App menu | Theme, text size (100–150%), install, update, logout |
| Heartbeat age | Host freshness |
| Delivery status | Handoff to agent; completion comes later |

Text also scales with viewport width.

## Configuration & storage

```bash
babysit config
export BABYSIT_HOME="/mnt/storage/babysit" # Host shell profile; absolute path
```

| Location / setting | Contents / effect |
|---|---|
| `${BABYSIT_HOME:-$HOME/.babysit}` | Config, sessions, clones, caches, recovery, default web bridge |
| `BABYSIT_WEB_BRIDGE_DIR` | Override bridge path; match Compose environment |
| Docker volumes | Persistent agent state; isolated `node_modules` / `.venv` |
| `config.isolate_dependencies: false` | Disable dependency volumes |
| `~/.babysitrc` | Shell setup before agent launch; skipped by `--ignore-host-agents-md` |

- `BABYSIT_HOME`: unset/empty → default; relative paths/literal `~` rejected. No automatic migration.
- Set storage on host, not in container rc. Export matching settings for Compose; rerun `recover init` after changes.
- Credentials, Docker volumes, tmux socket retain their locations; storage override alone does not isolate instances.
- Agent runs non-root in Docker/tmux; detached monitor applies rules and syncs credentials.
- Codex config is staged in a temporary copy; invalid TOML fails before staging.
- Codex host `auth.json` changes sync automatically; five-minute reconciliation remains as fallback.
- Codex reloads its own in-memory auth during same-account refresh/recovery; file sync does not force a reload.
- Image includes agent CLIs, coding tools, Chrome, Puppeteer, Xvfb, Poppler, qpdf.
- Image builds refresh agent CLIs on every run/attempt and log installed versions.
- `babysit update` allows 120 seconds for image pulls and reports the image version.
  Older/unlabelled images show `version unavailable`.
- Launch prompts contain brief mode boundaries and browser/session-control hints.
- `config` is read-only; unavailable systemd checks → unknown. Enablement and runtime state are separate.

## Develop

Requires **Bun**. Build outputs: static Linux/macOS binaries in `dist/`.

```bash
npm install
npm install --prefix web
npm run build
npm run test:all
```

| Check | Scope |
|---|---|
| `npm run test:cli` | CLI units |
| `npm run test:web` | Web API + browser interactions |
| `npm run test:bridge` | Browser → tmux; first `npm run build --prefix web` |
| `npm run test:prune` | Interactive pruning through real terminal |
| `npm run test:antigravity` | Real agy TUI/hooks/resume against local model fixture |
| `npm run test:codex` | Real Codex resume and permissions against local model fixture |
| `npm run test:numbers` | Real CLI history/recovery selectors and PTY resume attach/detach |
| `npm run test:close` | Real Docker/tmux numbered close and list renumbering (requires E2E image) |
| `npm run test:claude-controls` | Real Claude model/effort pickers, narrow panes, versioned IDs; no inference |
| `npm run test:controls` | Optional authenticated usage + native Claude controls through Docker |
| `npm run test:claude-dialog` | Optional: real Claude "Dangerous rm" prompt still matches YOLO approval; prints a drift report after Claude updates |
| `npm run test:e2e` | Docker launch, send, detach, resume, recovery, cleanup |
| `node tests/e2e/status.js` | Focused Docker/tmux activity regression |
| `node tests/e2e/credential-sync.js` | Host login watcher → running Docker container; dummy credentials, requires E2E image |

`test:all` runs the automated suites, also on PRs/main pushes. The optional
`test:controls` smoke uses local Claude credentials and checks available account quotas.
Set `BABYSIT_CONTROL_E2E_SUBAGENT=1` to also exercise real subagent-issued controls
(requires paid inference).
`test:claude-dialog` uses local Claude credentials and one small model call; exit 1 means the dialog changed.
Requires Docker, tmux, Python 3,
`agy` (`AGY_E2E_BINARY` override), `codex` (`CODEX_E2E_BINARY` override),
Claude Code 2.1.285, Chrome/Chromium (`CHROME_PATH` override).
Missing prerequisites fail. Clone E2E skips nested Docker; CI runs on host.
E2E uses real Docker/tmux without model API calls.

[Design contract](SPECIFICATION.md) · [Changelog](CHANGELOG.md) · MIT
