# babysit

Run LLM coding agents in durable Docker and tmux sessions. Babysit keeps them
alive after you detach, restores their sessions, and responds to terminal output
with simple rules.

Supports [Claude](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex),
[Gemini](https://github.com/google-gemini/gemini-cli), and
[OpenCode](https://github.com/anomalyco/opencode). Gemini supports enterprise
Code Assist and API-key accounts. Individual Google accounts moved to
Antigravity, which Babysit does not support.

## Install

Requires macOS or Linux, Docker, tmux, and Git.

```bash
curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash
```

The installer puts `babysit` in `~/.local/bin` without sudo.

## Start

```bash
babysit                         # Interactive launcher
babysit "feature 1"             # Launcher with a session name
babysit claude --yolo
babysit codex --clone --name "feature 1"
babysit codex --sandbox --loop
babysit gemini --mudbox
```

The launcher selects an agent CLI on the Model row. Use ↑/↓ to navigate,
←/→ to select Model or Mode, type on Name, and Space to toggle Docker, YOLO,
Clone, or Loop. Enter launches; Esc/Ctrl+C cancels. Mode cycles through Regular,
Sandbox, and Mudbox; Clone requires Regular and switches back automatically.

Menu selections persist per workspace directory, with the latest global selection
as fallback for new directories. Names are not remembered. Explicit agent commands
keep their existing behavior and do not read or update menu defaults. The menu
requires an interactive terminal; scripts should use explicit agent commands.

Codex defaults to `gpt-6-astra` with `medium` reasoning.

Detach with `Ctrl+B d`. Reattach with `babysit open`. Unrecognized flags pass
through to the agent:

```bash
babysit claude --yolo --model sonnet --effort high
```

An explicit model flag replaces Babysit's default model selection.

## Modes

| Flag | Workspace | Use |
|---|---|---|
| _(none)_ | Read-write mount | Normal work |
| `--yolo` | Read-write mount | Maximum autonomy; skip agent permissions |
| `--sandbox` | No mount | Ephemeral research or experiments |
| `--mudbox` | Read-only mount | Reviews and analysis |
| `--clone` | Durable copy plus `/original` | Isolated work with explicit merge-back |
| `--docker` | Additive | Use the host Docker daemon |
| `--ignore-host-agents-md` | Additive | Exclude host instructions and preferences; keep credentials |
| `--port PORT` or `--port H:C` | Additive | Publish a container port; repeat as needed |
| `--loop` | Additive | Continue when the agent becomes idle |

Modes combine. `--clone` cannot combine with `--sandbox` or `--mudbox`.
`--docker` weakens `--sandbox` and `--mudbox` because the Docker socket controls
the host daemon.

## Sessions

| Command | Result |
|---|---|
| `babysit list` | List active sessions |
| `babysit list --all` | Include IDs and tmux names |
| `babysit open [id\|name\|number]` | Attach to an active session |
| `babysit resume` | List this workspace's session history |
| `babysit resume --all` | List history from every workspace |
| `babysit resume <id> [flags]` | Restore a Babysit session |
| `babysit recover [id]` | Recover interrupted sessions across workspaces, detached |
| `babysit recover --dry-run [--json]` | Inspect recovery candidates and blockers |
| `babysit recover --no-continue [id]` | Reopen without submitting a continuation |
| `babysit recover init` | Enable Ubuntu boot recovery for this account |
| `babysit close <id>` | Close intentionally; exclude this launch from recovery |
| `babysit prune --list` | Show managed clone usage |
| `babysit prune` | Remove unused clones interactively |
| `babysit doctor --auth [agent]` | Verify agent authentication |
| `babysit update` | Update Babysit, agent tools, and the image |

Pruning needs writable space for lock records and recovery journals. If the
filesystem is full, free some space first, then retry `babysit prune`.

Detaching or exiting the agent (for example, `/exit`) shows the remaining active
sessions.

`babysit list` samples current panes over one second. Agent input/interrupt
controls determine `idle`/`running`; unrecognized screens fall back to output
stability. Unreadable panes show `unknown`. Attachment is reported separately.

Use `--log[=PATH]` to append raw tmux output to a file. Run `babysit --help` for
the complete CLI reference.

### Recovery

`babysit recover` restores sessions left open through power loss, reboot, or
process failure. It resumes the exact saved conversation and submits:
“You were interrupted. Check the current state, then continue unfinished work.”
Idle sessions are included. Live agents keep running; missing monitors are repaired.
Repeated recovery does not duplicate a running session. Attach with `babysit open`.

Normal agent exit and `babysit close <id>` retire a session. Detaching and host
shutdown preserve recovery intent. Only sessions launched with recovery support
are eligible; use `babysit resume` for older history. Sandbox sessions remain
ephemeral. Missing transcripts, changed workspace configuration, unsupported
launch arguments, and unavailable prerequisites are reported instead of guessed.
Model/effort/variant options, modes, ports, credential-home paths, and the original
image are retained; credentials are reloaded. Custom tmux sockets require the same
`BABYSIT_TMUX_SOCKET`. Unflushed work and in-flight subprocesses cannot be restored.

If a second crash makes continuation delivery uncertain, recovery reports it.
Inspect the conversation, then use `--no-continue` to acknowledge without resending.
This does not undo input already submitted or actions already completed.

On Ubuntu with system Docker, run `babysit recover init` as the session owner
(let it prompt for sudo internally). It installs and enables `babysit-recover-<uid>.service` for
the next boot; it does not restart current sessions. The account needs direct
Docker access. The installer prompts for sudo authorization in a terminal;
unattended installation needs root or cached/passwordless sudo. Initialization checks
Babysit, `sh`, `tmux`, `docker`, `cat`, `ps`, and Docker access as the service user
with a clean boot environment. It records an absolute Babysit path and explicit PATH;
login shell settings are not loaded. Explicit `sudo babysit recover init` preserves
the original account but can lose custom PATH entries—prefer normal-user invocation.
Its home/workspaces and credentials must be available before login; login-unlocked homes/keyrings and
rootless/remote Docker need separate host setup and are not supported by this installer.
Rerun initialization after moving the executable or adding workspace mount dependencies.

```bash
babysit recover init
journalctl -u "babysit-recover-$(id -u).service"
sudo systemctl disable "babysit-recover-$(id -u).service" # Disable future boot recovery
```

Boot recovery uses bounded retries, reports failures in the journal, and leaves
successful sessions running. Stopping the service suspends its sessions while
preserving recovery intent; use `babysit close` to retire individual sessions.

## Change reasoning effort

Inside a newly started Codex or OpenCode session, agents can run:

```bash
babysit effort          # Current setting and supported levels for this model
babysit effort high
babysit effort low
```

Changes apply to the next model request, including within the current turn.
Requests already running finish with their original effort. The model stays the same.

Codex updates its native thread and active-turn settings, including the TUI footer.
OpenCode uses a session-specific plugin override; its footer still shows the TUI's
own variant. Run `babysit effort default` in OpenCode to restore that variant.
If its effort lookup fails, OpenCode warns and uses the TUI variant for that request.
Supported values come from the current model; they are not limited to `high`.

Requires the updated Docker image and supported CLIs (verified with Codex 0.153.4
and OpenCode 1.18.29). Existing containers need a new launch. Claude and Gemini
are unsupported. Explicit remote/headless sessions, Codex `--profile`, and
OpenCode `--pure` retain their normal launch without effort controls.

## Supervision

The first run creates `babysit.yaml`. This compact example shows its core shape.
Rules are evaluated from top to bottom; the first match wins.

```yaml
config:
    idle_timeout_s: 300

babysit:
    # Uncomment only the rules you want.
    # - on: plan
    #   do: accept
    #   timeout: 10

    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00
```

Triggers: `idle`, `plan`, `choice`, a quoted literal, or `/regex/flags`.

Actions: `enter`, `accept`, `shift_tab`, a command named under
`config.commands`, text to submit, or a Markdown file. Split Markdown workflows
on `===` to wait for idle between steps. Timeouts accept `SS`, `MM:SS`, or
`HH:MM:SS`.

`--loop` uses the first available instruction source:

1. `./LOOP.md`
2. `~/.agents/LOOP.md` (skipped with `--ignore-host-agents-md`)
3. `Keep going`

## Mobile web companion

Initialize the host bridge and print its access token:

```bash
babysit web init
```

Running sessions discover the bridge after initialization. When upgrading from
an older Babysit version, exit and resume existing sessions once to load the
updated monitor and terminal helpers.

The web view shows the latest completed reply, retaining it while the agent
works on the next turn. Expand **Terminal output** to see live tool steps and
prompts. After upgrading from screen-based message capture, exit and resume
existing sessions to enable completion capture; the first new reply fills the
message view.

Use the **app menu** for theme (system/light/dark), text size (100–150%),
installation, updates, and logout. Text also scales with viewport width.
On mobile, **Reply ↓** jumps to the composer. Draft while busy; send once
unlocked. **Copy** copies code blocks. Heartbeat age describes host freshness,
not reply age; delivery status confirms handoff to the agent, not completion.

Run the production Compose example behind a TLS proxy:

```bash
BABYSIT_WEB_UID="$(id -u)" \
BABYSIT_WEB_GID="$(id -g)" \
BABYSIT_WEB_PROXY_NETWORK="proxy" \
BABYSIT_WEB_PUBLIC_ORIGIN="https://babysit.example.com" \
docker compose -f examples/compose.web.yml up -d
```

For loopback-only local use:

```bash
BABYSIT_WEB_UID="$(id -u)" \
BABYSIT_WEB_GID="$(id -g)" \
docker compose -f examples/compose.web.local.yml up --build -d
```

Open `http://127.0.0.1:3000`. The companion receives sanitized session state and
a request queue—not Docker, tmux, home-directory, or workspace access. Keep
`~/.babysit/web-bridge` private; run `babysit web init` again to rotate its
token.

Route the production proxy to `http://babysit-web:3000` on the shared network;
the service publishes no host port. Preserve the original host,
`X-Forwarded-Proto`, and `X-Forwarded-For`. To move the bridge, set
`BABYSIT_WEB_BRIDGE_DIR` to the same absolute path for Babysit and Compose.

## Runtime

- The agent runs as a non-root user in a Docker container inside tmux.
- A detached monitor applies `babysit.yaml` rules and keeps credentials in sync.
- Agent state lives in persistent Docker volumes. Babysit metadata lives under
  `~/.babysit`.
- Codex settings are copied into a temporary container configuration; the host
  file stays untouched. Invalid TOML produces a configuration error before staging.
- `node_modules` and `.venv` use named volumes by default to avoid host/container
  binary conflicts. Set `config.isolate_dependencies: false` to disable this.
- The image includes all supported agent CLIs, common coding tools, Chrome,
  Puppeteer, Xvfb, Poppler, and qpdf.
- Authentication checks use real model requests and cache successes for 12
  hours. Add `--refresh` to `babysit doctor --auth` to bypass the cache.

If `~/.babysitrc` exists, Babysit sources it before launching the agent. Use it
for local environment variables and tool setup. `--ignore-host-agents-md` skips
this file because executable shell cannot be separated safely from host
preferences.

## Develop

Requires [Bun](https://bun.sh).

```bash
npm install
npm install --prefix web
npm run build
npm run test:all
```

`test:all` checks CLI units, web API/browser interactions, browser-to-tmux
delivery, and Docker session lifecycles. Requires Docker, tmux, Python 3, and
Chrome/Chromium (`CHROME_PATH` overrides discovery). Missing prerequisites fail
the run. Pull requests and main pushes run the same suite. Clone E2E requires
host execution; nested Docker runs skip it, while CI runs it on the host.

Focused checks:

```bash
npm run test:cli
npm run test:web
npm run test:bridge # Build web assets first: npm run build --prefix web
npm run test:prune # Interactive CLI pruning through a real terminal
npm run test:e2e   # Docker launch, send, detach, resume, recovery, cleanup
node tests/e2e/status.js # Focused activity regression with Docker and tmux
```

`npm run build` creates static Linux and macOS binaries in `dist/`. The E2E
suite exercises real Docker and tmux sessions without calling model APIs.

See [SPECIFICATION.md](SPECIFICATION.md) for the design contract and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
