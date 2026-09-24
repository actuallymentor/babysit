# babysit

Durable Docker + tmux sessions for coding agents. Detach, resume, recover;
automate terminal responses with YAML rules.

Supports [Claude](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex),
[Antigravity](https://antigravity.google/docs/cli/overview/), and
[OpenCode](https://github.com/anomalyco/opencode).

## Quick start

Requires **macOS/Linux, Docker, tmux, Git**. Installs to `~/.local/bin`; no sudo.

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
| `--yolo` | Maximum autonomy; skip agent permissions |
| `--sandbox` | No workspace mount; ephemeral |
| `--mudbox` | Read-only workspace mount |
| `--clone` | Durable workspace copy + `/original`; explicit merge-back |
| `--docker` | Host Docker daemon access |
| `--ignore-host-agents-md` | Skip host instructions, preferences, rc file; keep credentials |
| `--port PORT` / `--port H:C` | Publish port; repeatable |
| `--loop` | Continue on idle |
| `--log[=PATH]` | Append raw tmux output to file |

Flags combine. `--clone` excludes `--sandbox` / `--mudbox`. `--docker` weakens isolation:
the socket controls the host daemon, including in Sandbox/Mudbox.

## Sessions

| Command | Effect |
|---|---|
| `babysit list [--all]` | Active sessions; `--all` adds IDs/tmux names |
| `babysit open [id\|name\|number]` | Attach |
| `babysit resume [--all]` | Workspace history; all history if none here or `--all` |
| `babysit resume <id\|number> [flags]` | Restore saved session |
| `babysit <agent> resume <id\|number> [flags]` | Restore; selected history row must match agent |
| `babysit close <number or id>` | Close by list number or ID; retire launch from recovery |
| `babysit prune --list` | Managed clone usage |
| `babysit prune` | Interactively prune unused Docker data and managed clones |
| `babysit doctor --auth [agent] [--refresh]` | Real auth check; bypass 12h cache with `--refresh` |
| `babysit config` | Effective paths, image, socket, menu defaults, web/recovery status |
| `babysit update` | Update Babysit, agent tools, image |

Detach or agent exit shows remaining sessions. `list` samples panes for 1s:
input/interrupt controls → idle/running; otherwise output stability; unreadable → unknown.
Attachment is separate. Pruning needs free space for locks/journals.
Docker cleanup removes stopped containers, unused networks and images, and build cache across the current Docker daemon. It keeps volumes and requires a separate confirmation. `prune --list` only lists clones.
Old resume IDs follow their latest launch; history shows current launches and saved status.

Numbers use each command's current listing:

- `open N` / `close N`: `babysit list`.
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
babysit model                 # Available models for this agent
babysit model <model-name>     # Switch within this agent
babysit effort                # Supported effort levels
babysit effort high
babysit model --status <id>    # Result of a queued terminal request
babysit effort --status <id>
```

Changes affect this session, not future launch defaults. Compatible effort is
preserved; switching to an incompatible model selects its default effort.
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

First launch creates `babysit.yaml`. Rules run top-down; first match wins.

```yaml
config:
    idle_timeout_s: 300

babysit:
    # Uncomment wanted rules.
    # - on: plan
    #   do: accept
    #   timeout: 10

    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00
```

| Setting | Values |
|---|---|
| `on` | `idle`, `plan`, `choice`, quoted literal, `/regex/flags` |
| `do` | `enter`, `accept`, `shift_tab`, named `config.commands` command, text, Markdown file |
| `timeout` | `SS`, `MM:SS`, `HH:MM:SS` |
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
- Image includes agent CLIs, coding tools, Chrome, Puppeteer, Xvfb, Poppler, qpdf.
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
| `npm run test:controls` | Optional authenticated usage + native Claude controls through Docker |
| `npm run test:e2e` | Docker launch, send, detach, resume, recovery, cleanup |
| `node tests/e2e/status.js` | Focused Docker/tmux activity regression |

`test:all` runs the automated suites, also on PRs/main pushes. The optional
`test:controls` smoke uses local Claude credentials and checks available account quotas.
Requires Docker, tmux, Python 3,
`agy` (`AGY_E2E_BINARY` override), `codex` (`CODEX_E2E_BINARY` override),
Chrome/Chromium (`CHROME_PATH` override).
Missing prerequisites fail. Clone E2E skips nested Docker; CI runs on host.
E2E uses real Docker/tmux without model API calls.

[Design contract](SPECIFICATION.md) · [Changelog](CHANGELOG.md) · MIT
