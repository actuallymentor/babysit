# babysit

Durable Docker + tmux sessions for coding agents. Detach, resume, recover; automate terminal responses with YAML rules.

Supports [Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [OpenCode](https://github.com/anomalyco/opencode).

## Quick start

Needs **macOS/Linux, Docker, tmux, Git** (+ **rsync** on Linux). Installs to `~/.local/bin`, no sudo.

```bash
curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash
```

```bash
babysit                                  # Interactive launcher
babysit "feature 1"                      # Launcher with session name
babysit claude --yolo
babysit codex --clone --name "feature 1"
babysit codex --sandbox --loop
babysit opencode --mudbox
babysit claude --yolo --model sonnet --effort high   # unknown flags pass through
```

**Detach:** `Ctrl+B d` · **Reattach:** `babysit open` · **Help:** `babysit --help`, `babysit help <command>`

Defaults: Codex `gpt-6-astra` / `medium`; Claude `default` / `medium` (`--model best` = Fable, smaller weekly cap). Explicit flags win.

### Launcher

| Input | Action |
|---|---|
| ↑/↓ | Navigate rows |
| ←/→ | Agent, Mode, Claude account |
| Type | Name, ports (`5173, 3000:80`), log, agent args |
| Space | Toggle Docker, Devices, YOLO, Clone, Loop; open Advanced |
| Enter / Esc | Launch / cancel |

Mode: Regular → Sandbox → Mudbox (Clone forces Regular). Agent, mode and switches persist per workspace; names and Advanced values don't. Needs a TTY; use explicit commands in scripts.

## Flags

| Flag | Effect |
|---|---|
| _(none)_ | Read-write workspace mount |
| `--yolo` | Maximum autonomy: skip agent permission prompts, `AGENT_AUTONOMY_MODE=yolo` |
| `--docker` | Mount the host Docker socket (controls the host daemon, even in sandbox) |
| `--adb` | Android adb with a key shared by every session (network devices only) |
| `--ios` | iOS 16 devices via WebDriverAgent, pairing shared by every session (network only) |
| `--mac` | Remote Macs (SSH + Screen Sharing); credentials from babysit mac add reach only these sessions |
| `--devices` | Every device kind: --adb, --ios and --mac |
| `--clone` | Work in a durable copy; the original is mounted read-only at `/original` |
| `--loop` | When idle, type `./LOOP.md`, `~/.agents/LOOP.md`, or "Keep going" |
| `--sandbox` | No workspace mount; the container and its files are thrown away |
| `--mudbox` | Read-only workspace mount |
| `--ignore-host-agents-md` | Leave out host instructions, skills, preferences, and `~/.babysitrc` setup; keep credentials |
| `--yes` | Skip clone safety and `--config DIR/` confirmation prompts; with "audit", apply required fixes |
| `--name NAME` | Human-readable session name (shown in babysit list, usable with open) |
| `--config FILE` | Use FILE instead of `./babysit.yaml`; kept on resume and in clones |
| `--port PORT` | Publish host PORT to the same container port; repeatable |
| `--port H:C` | Publish host port H to container port C |
| `--log[=PATH]` | Append raw tmux output to PATH (default `.YYYY_MM_DD_HH_MM.babysit.log`) |
| `--account NAME` | Claude: run on this subscription (babysit auth accounts); default picks most headroom |

Flags combine. `--clone` excludes `--sandbox`/`--mudbox`. `--docker` weakens isolation (host daemon control, even in sandbox).

- `--yolo` on Claude also accepts blocking prompts whose default is yes (e.g. rm checks); never model swaps or billing
- `--adb` / `--ios` / `--mac`: see [Android devices](#android-devices---adb), [iOS devices](#ios-devices---ios), [Remote Macs](#remote-macs---mac)
- `--config FILE`: opens the launch menu prefilled from its `launch:`; relative `do: ./X.md` paths resolve beside FILE

### Clone

- Git repo root: `git clone` of committed state (all refs), plus untracked/ignored paths matching `carry`. Dependencies and build output not copied
- Plain folders, subdirectories, LFS/git-crypt repos, `mode: copy`: working-tree copy minus `exclude`
- Unreadable paths you own: listed with the `chmod` fix; `y` or `--yes` applies it

```yaml
config:
    clone:
        mode: git            # git | copy
        carry: ['.env', '.env.*', '.notes', 'babysit.yaml']
        changes: false       # true: carry uncommitted edits
        depth: null          # N: shallow
        exclude: ['node_modules']   # copy mode
```

## Sessions

Status: `running` (foreground work), `waiting` (background shells/subagents), `idle`. Idle rules don't fire while waiting.

| Command | Effect |
|---|---|
| `babysit init [file.yaml]` | Write a default config, then open the launch menu to fill `launch:` |
| `babysit --config DIR/ [--yes]` | Start every `DIR/*.yaml` detached; see [Directory launch](#directory-launch) |
| `babysit audit --config FILE\|DIR/` | Fix yaml for `--config DIR/`; see [Audit](#audit) |
| `babysit clean --config FILE\|DIR/ [--dry-run]` | Strip comment lines and blanks; see [Clean](#clean) |
| `babysit list [--all]` | Sessions as a tree: status, CPU/MEM, flags. Blue ● = turn finished, grey ● = idle >24h. `--all` adds IDs, tmux names |
| `babysit watch [--usage\|--all] [--interactive]` | Live `list` + usage. `--interactive`: type a number to open, ctrl+c to close |
| `babysit fork <n\|id> [agent] [flags]` | Continue a session in a new one; see [Fork](#fork) |
| `babysit open [id\|name\|number]` | Attach; shell `cd`s to the session's base dir (needs `eval "$(babysit shell-init)"` in your rc) |
| `babysit shell-init [bash\|zsh\|fish]` | Print the shell function behind `open`. Fish: `babysit shell-init fish \| source` |
| `babysit resume [--all] [-n N]` | Workspace history, newest 10 (`-n N` rows, `--all` workspaces) |
| `babysit resume <id\|number> [flags]` | Restore a saved session (`babysit <agent> resume …` must match its agent) |
| `babysit close <n\|id>...` | Close and retire from recovery; numbers resolve before the first close |
| `babysit restart <n\|id\|all>... [--force] [--detach] [--continue] [--account NAME]` | Close gracefully, resume on the current image. Needs an idle/waiting agent and captured session id (`--force` overrides). Claude moves to the account with most headroom |
| `babysit freeze <n\|id\|all>...` / `unfreeze` | `docker pause` in place; host only. Ends at reboot; `close` unpauses |
| `babysit archive [<n\|id>...] [--yes]` | Sink sessions to the bottom of the list (they keep running). No selectors: offers every grey-dot session. `open` un-archives |
| `babysit prune [--list]` | Show reclaimable space; interactively prune unused Docker data and managed clones |
| `babysit doctor --auth [agent] [--refresh]` | Real auth check (one prompt per agent); `--refresh` bypasses the 12h cache |
| `babysit auth [status]` | Cached auth ages, checker state |
| `babysit auth check [agent] [--force]` | Run the checker now |
| `babysit auth accounts [remove NAME]` | Claude subscriptions; see [Claude accounts](#claude-accounts) |
| `babysit auth init [--remove] [--no-linger]` | Install/remove the 10-min checker (systemd user timer / launchd) |
| `babysit config` | Effective paths, image, defaults, web/recovery status |
| `babysit mode` | `container` inside a session, `host` otherwise |
| `babysit update [--auto]` | Update Babysit, agent tools, image, web container. `--auto`: background updates on new releases |

Numbers refer to the listing of the command they're used with: `open`/`close`/`archive` → `babysit list`; `resume N` → `babysit resume` (`resume N --all` for `resume --all` rows); `recover N` → `babysit recover --dry-run`. Re-list after changes, or use IDs.

### Login

- Launch makes no model call: it checks the agent's staged login locally and asks only when there's nothing to log in with. Every installed agent still gets credentials, so nested `claude`/`codex` work
- `babysit auth init` once → 10-min checker (`babysit config` shows state). `doctor --auth` does a real probe
- Pushover alerts (`PUSHOVER_TOKEN` + `PUSHOVER_USER` in `~/.babysitrc`): agent logged out, any usage limit at 90%
- OpenCode borrows the Codex ChatGPT login (access token only, never written to host OpenCode `auth.json`) and then prefers it over OpenRouter; its own `openai` login wins

**Claude** in containers runs only on a one-year setup-token (host `/login` is never copied, so sessions can't log each other out). No token or other route → launch stops and says how to import:

```bash
babysit auth init --claude-token                                  # runs claude setup-token, or paste one
echo "$TOKEN" | babysit auth init --claude-token --token-stdin    # no TTY; --name NAME for a named account
```

- Default token lands in `~/.babysitrc` (0600) as `CLAUDE_CODE_OAUTH_TOKEN`; restart Claude sessions to switch
- Model requests only: claude.ai connectors/Remote Control need `/login`
- `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`, Bedrock, Vertex or Foundry works instead, no token needed

### Recovery

| Command | Effect |
|---|---|
| `babysit recover [id\|number]` | Recover interrupted sessions, detached, across workspaces |
| `babysit recover --dry-run [--json]` | Inspect candidates/blockers |
| `babysit recover --no-continue [id\|number]` | Reopen without the continue prompt |
| `babysit recover init` | Enable Ubuntu boot recovery for this account |

Resumes the saved conversation and sends "You were interrupted. Check the current state, then continue unfinished work." Normal exit or `close` retires a session. Unflushed work and in-flight subprocesses are lost; sandboxes stay ephemeral. Missing transcripts, changed config or unsupported args block recovery. Custom tmux sockets need the same `BABYSIT_TMUX_SOCKET`.

**Boot recovery (Ubuntu):** needs system Docker and home/workspaces/credentials available before login.

```bash
babysit recover init
journalctl -u "babysit-recover-$(id -u).service"
sudo systemctl disable "babysit-recover-$(id -u).service"   # turn off
```

Unattended init needs root or cached sudo (skip a `sudo` prefix: it strips PATH/storage exports). Rerun after moving the executable or storage.

## Fork, audit, clean, accounts

### Fork

Hand a session to another agent or mode without losing work or chat.

```bash
babysit fork 3 codex              # Claude stuck? Codex picks it up
babysit fork 3 --docker           # same agent + chat, now with Docker socket
babysit fork 3 opencode --mudbox  # read-only reviewer on the live tree
babysit fork 3 --clone --takeover # snapshot copy, close the original
```

- Filesystem: live parent → clone snapshot; exited/stuck parent → share; `--mudbox` → read-only share. `--share`/`--clone` skip the prompt, `--yes` takes the default
- Chat: same agent → native fork; other agent → transcript handoff as first prompt. `--no-history` starts clean
- Inherits modes, config, model/effort (same agent), Claude account. `--regular` / `--no-yolo|docker|adb|ios|loop` drop inherited ones
- `--takeover` closes a live parent without asking
- Launcher: `f` (off the Name row) picks a session to fork

### Audit

```bash
babysit audit --config agents/      # every agents/*.yaml, interactive
babysit audit --config api.yaml --yes
```

Asks for missing `agent`, unset `mode` and switches; shows a diff before writing; keeps comments. Non-TTY: report only (exit 1 on failure). `--yes`: fixes only.

### Clean

```bash
babysit clean --config babysit/config.yaml
babysit clean --config sessions/ --dry-run
```

Removes full-line comments and blank lines, keeps inline comments and block strings. Rewrites only if values are unchanged. Not undoable outside git.

### Claude accounts

Spread work over several subscriptions; babysit switches when one runs out.

```bash
babysit auth init --claude-token --name work      # once per subscription
babysit auth accounts                             # name, expiry, headroom (never tokens)
babysit claude --account work                     # force one; default = most headroom
babysit restart all --account failover            # move every Claude session
babysit auth accounts remove personal
```

- Existing `~/.babysitrc` token = account `default`. Every session gets one account, so nested `claude` works in Codex/OpenCode too
- On a limit the session hot-swaps to the next account with headroom: token rewritten in place, Esc + continue prompt, same conversation. Attached → you type the continue. Never back to an account until its window resets. Off: `claude_account_auto_switch: false`
- Sessions from before 2.0 switch by restart instead
- `usage`/`watch` show `claude / <account>` rows

## Model and effort

Inside a managed session:

```bash
babysit model                 # Available models + top 35 intelligence benchmarks
babysit model <name>          # Switch within this agent
babysit effort [level]        # List / set effort
babysit model --status <id>   # Result of a queued request (same for effort)
babysit exit [--yes]          # End gracefully after the current turn (asks first)
babysit stuck                 # Mark "stuck" in list until the user types
babysit loop                  # Toggle --loop
babysit reset                 # Clear context, retype the initial prompt
```

- Changes affect this session only; incompatible model → default effort. Requests queue up to 60s and return an ID
- Needs an updated image and a new container with its host monitor; not available in remote/headless sessions, Codex `--profile`, OpenCode `--pure`
- `exit` is for when the user explicitly asked; it marks the session closed (no recovery)

### Benchmarks

```bash
babysit model --benchmarks                         # Intelligence descending
babysit model --benchmarks --sort cost --limit 20
babysit model --benchmarks --json
```

Sorts: `intelligence` (default), `coding`, `agentic`, `cost`, `cost-per-point`, `name`. Needs `ARTIFICIAL_ANALYSIS_API_KEY` (free API) in `~/.babysitrc`; optional `ARTIFICIAL_ANALYSIS_TTL_MINUTES=15` (`0` = no cache). Cached in the shared Docker cache volume; failed refreshes use stale data. Only providers with installed CLIs/credentials are listed.

## Android devices (`--adb`)

```bash
babysit adb pair 192.168.2.114:38775 758418 --name dev-phone   # once, from any --adb session
babysit adb                   # reconnect recorded devices (also at launch)
babysit adb list
babysit adb add HOST[:PORT]   # already-paired device
babysit adb forget HOST
```

Network devices only; host at `host.docker.internal`. Reconnect order: `host:5555` → last Wireless debugging port → scan 37000–50000; `adb tcpip 5555` pins the port until reboot (`--no-tcpip` opts out). Phone: static IP, Developer options → *Disable adb authorization timeout*.

## iOS devices (`--ios`)

iOS 16 and older, over the LAN. One-time on a Mac: Developer Mode + *Enable UI Automation*, build/install WebDriverAgent with Xcode, tick *Show this iPhone when on Wi-Fi*, copy `/var/db/lockdown/UDID.plist`.

```bash
babysit ios add 192.168.2.75 UDID ./UDID.plist --name iphone --runner BUNDLE.xctrunner   # once
babysit ios                   # launch WebDriverAgent on recorded devices (also at launch)
babysit ios list
babysit ios forget iphone
```

Control with `facebook-wda` at `http://HOST:8100`; post `waitForIdleTimeout=0` and `animationCoolOffTimeout=0` to `session/ID/appium/settings` first or `source()` fails. WebDriverAgent is relaunched automatically; free Apple IDs re-sign every 7 days.


## Remote Macs (`--mac`)

SSH (key) for structured control, Screen Sharing (VNC) for the GUI. Dedicated LAN Mac, e.g. `--devices` or `--mac`.

```bash
babysit mac add office 192.168.2.236 --user mentor --password-stdin   # once; installs the ssh key
babysit mac check|list|forget
```

- Mac, once: Remote Login + Screen Sharing on (Sharing settings), sleep and lock off, an account for agents
- Host: `~/.babysit/macs/` (0700; registry has no secrets, password + ed25519 key per Mac, 0600). Linux host, no Keychain
- Secrets are uploaded into the stopped container (`docker cp`) only for `--mac`/`--devices` sessions, installed 0700 in `~/.config/babysit-mac`; never in `Config.Env`, mounts, argv, config files or logs
- In session: `babysit mac ssh|sudo|scp NAME ...`, GUI `shot|click|move|drag|type|key|scroll|unlock`; the agent is told never to destroy other users' data
- GUI typing is paced (≈3 s start-up, macOS drops early keys); agents are told to screenshot and read typed text before pressing Return
- Enable sshd without Full Disk Access: `sudo launchctl enable system/com.openssh.sshd && sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist`
- Gates credentials, not the network: the LAN stays reachable from any container

## Account usage

```bash
babysit usage                 # Host or container
babysit usage --json
```

Claude/Codex quota windows and resets, OpenRouter budgets and spend. Green <50%, yellow <70%, red above. Exit 1 = unavailable usage or fetch errors. No inference, except one 1-token Haiku request when only a setup-token is available.

```
claude / anthropic
  limit                  used  resets
  session                2%    in 3h 25m Oct 9 13:09
  weekly_all             65%   in 3d 6h Oct 12 15:59
```

## Supervision

`babysit init` writes a commented `babysit.yaml` (or use `--config FILE`). Rules run top-down; first match wins.

```yaml
config:
    idle_timeout_s: 300
    watchdog_idle_s: 1800    # stall watchdog; 0 disables
    watchdog_waiting_s: 900
    yolo_approve_dangerous_commands: true

babysit:
    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00
    # - on: /error/i
    #   do: notify_command
```

| Setting | Values |
|---|---|
| `on` | `idle`, literal text, `/regex/flags` (matched against the last 10 pane lines) |
| `do` | `enter`, named `config.commands` entry, text, Markdown file |
| `timeout` | Idle rules: `SS`, `MM:SS`, `HH:MM:SS` |
| `run_on_start` | Idle rules: fire on first idle instead of after a full timeout |
| Markdown steps | Separate with `===`; waits for idle between steps |
| `--loop` source | `./LOOP.md` → `~/.agents/LOOP.md` → `Keep going` |

**Stall watchdog** (on by default): nudges agents that silently stopped.
- **Idle** `watchdog_idle_s`: Haiku reads the last 150 lines; if stalled (not parked on purpose), types a nudge. Skipped when an idle rule or `--loop` exists
- **Waiting** `watchdog_waiting_s`: asks the agent to audit its process tree and kill what can't finish. Repeats until it runs again
- Skipped while `stuck`. Verdicts in `~/.babysit/monitor-logs/<id>.log`

### Directory launch

`launch:` declares how a session starts (`babysit init` writes it from the launch menu).

```yaml
launch:
    agent: claude            # claude | codex | opencode
    name: api reviewer       # default: file name
    mode: regular            # regular | sandbox | mudbox
    yolo: true
    docker: false
    adb: false
    ios: false
    mac: false
    devices: false           # true = adb + ios + mac
    clone: true
    loop: false
    ignore_host_agents_md: false
    ports: []                # PORT or HOST:CONTAINER
    log: false               # false | true | path
    args: ["--model", "opus"]
```

`babysit --config DIR/` starts every `DIR/*.yaml|yml` (not recursive) in the current directory:

- Strict: `launch:` and `agent` required, all values valid; one bad file aborts the run
- Shows an overview, asks `Start N sessions? [y/N]` (`--yes` skips; required without a TTY)
- Skips files whose session is still live; starts one at a time, detached; a failure skips that file only
- Agent, name and flags live in the yaml, not on the command line

## Mobile web companion

```bash
babysit web init         # Initialize bridge, print token; rerun to rotate
babysit web key add NAME # Read-only API key, shown once; also list / remove NAME

# Local: http://127.0.0.1:3000
BABYSIT_WEB_UID="$(id -u)" BABYSIT_WEB_GID="$(id -g)" \
docker compose -f examples/compose.web.local.yml up --build -d
```

Behind a TLS proxy:

```bash
BABYSIT_WEB_UID="$(id -u)" BABYSIT_WEB_GID="$(id -g)" \
BABYSIT_WEB_PROXY_NETWORK="proxy" BABYSIT_WEB_PUBLIC_ORIGIN="https://babysit.example.com" \
docker compose -f examples/compose.web.yml up -d
```

- Proxy → `http://babysit-web:3000` on the shared network; forward host, `X-Forwarded-Proto`, `X-Forwarded-For`
- Keep the bridge directory private (custom path: same absolute `BABYSIT_WEB_BRIDGE_DIR` for Babysit and Compose). The companion has no Docker/tmux/home access
- Login lasts 30 days (`BABYSIT_WEB_SESSION_TTL_MS`); token rotation and logout end sessions
- After upgrades, exit/resume old sessions to load updated helpers

**JSON API:** cookie, or `Authorization: Bearer <key>` (read-only, GET only). Full reference: **API docs** in the app menu.

```bash
curl -H "Authorization: Bearer $BABYSIT_KEY" https://babysit.example.com/api/status
```

| Endpoint | Returns |
|---|---|
| `GET /api/status` | Sessions, container CPU/MEM totals, account usage |
| `GET /api/sessions` | `{ sessions[] }` with container stats |
| `GET /api/sessions/:id` | `{ session, pending }` |
| `GET /api/me` | `{ role }` |

## Transcript archive

Native agent transcripts (messages, tool calls/results, token usage, subagents) are mirrored to `~/.babysit/transcripts` every 10 min and at session end. On by default.

```bash
babysit config --transcripts PATH|off|default
```

- Files stay in each agent's own format (JSONL, SQLite); layout: `volumes/<volume>/`
- Credential-looking files skipped; tool output may still hold secrets (archive `0700`, files `0600`)
- Best effort: failed passes retry; sandboxes are removed even if the final copy fails

## Configuration & storage

| Location / setting | Contents / effect |
|---|---|
| `${BABYSIT_HOME:-$HOME/.babysit}` | Config, sessions, clones, caches, recovery, web bridge, transcripts |
| `BABYSIT_WEB_BRIDGE_DIR` | Override bridge path; match Compose |
| Docker volumes | Persistent agent state; isolated `node_modules` / `.venv` |
| `config.isolate_dependencies: false` | Disable dependency volumes |
| `~/.babysitrc` | Shell setup sourced by host `babysit` commands and before agent launch (skipped by `--ignore-host-agents-md`) |

- `BABYSIT_HOME` must be absolute; set it on the host, export matching values for Compose, rerun `recover init` after changing
- Image ships agent CLIs, Chrome/Puppeteer, adb/fastboot, uiautomator2, pymobiledevice3; `babysit update` refreshes it and reports the version

## Develop

Requires **Bun**. Binaries build to `dist/`.

```bash
npm install && npm install --prefix web
npm run build
npm run test:all
```

Individual suites: `test:cli`, `test:web`, `test:bridge` (after `npm run build --prefix web`), `test:prune`, `test:codex`, `test:numbers`, `test:close`, `test:claude-controls`, `test:controls`, `test:claude-dialog`, `test:e2e`. E2E needs Docker, tmux, Python 3, `codex`, Chrome/Chromium and makes no model calls; `test:controls` and `test:claude-dialog` use real Claude credentials.

[Design contract](SPECIFICATION.md) · [Changelog](CHANGELOG.md) · MIT
