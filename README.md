# babysit

A supervisor for LLM coding agent CLIs. Runs [Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini](https://github.com/google-gemini/gemini-cli), and [OpenCode](https://github.com/anomalyco/opencode) inside Docker containers with tmux session management and declarative supervision rules.

Gemini CLI supports enterprise Code Assist and API-key accounts. Individual Google-login accounts moved to Antigravity, whose CLI Babysit does not yet adapt.

Spiritual successor to [sir-claudius](https://github.com/actuallymentor/sir-claudius) — rebuilt from scratch with multi-agent support, configurable supervision via `babysit.yaml`, and a single static binary.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash
```

The installer detects your OS and architecture, downloads the correct binary to `~/.local/bin/babysit` (no sudo required), and checks that `docker`, `tmux`, and `git` are installed. If `~/.local/bin` isn't on your `$PATH` yet, the script tells you the line to add to your shell rc.

## Quick start

```bash
# Start Claude in yolo mode (max autonomy, skip permissions)
babysit claude --yolo

# Codex in a sandbox (no host files mounted) with loop mode
babysit codex --sandbox --loop

# Give a session a memorable name
babysit codex --name "feature 1"

# Work in a durable copy; mount the source separately at /original
babysit codex --clone --name "feature 1"

# Gemini with read-only workspace
babysit gemini --mudbox

# List resumable sessions for the current workspace
babysit resume

# List resumable sessions from every workspace
babysit resume --all

# Resume a previous session by its Babysit ID
babysit resume <session_id> --yolo

# List active sessions with numbers, names, and launch flags
babysit list

# Review clone disk usage or interactively prune unused copies
babysit prune --list
babysit prune

# Include IDs and full tmux session names
babysit list --all

# Attach to the only running session for the current directory
babysit open

# Attach to a specific running session
babysit open <session_id>

# Open row 2 from babysit list, or open one by name
babysit open 2
babysit open "feature 1"

# Verify every agent login, or one agent, on demand
babysit doctor --auth
babysit doctor --auth opencode --refresh
```

## How it works

1. **Docker preflight** — before tmux starts, babysit verifies that the Docker daemon is reachable and prints the Docker connection error if it is not
2. **Host auth check** — before the main session starts, babysit verifies the active agent plus supported non-active agent CLIs found on host PATH. Cache misses run concurrently; a successful check is reused for 12 hours while its hashed auth inputs and local Docker image identity remain unchanged. Press Enter to skip the entire auth decision for one interactive launch. Non-interactive launches verify misses and fail closed. `babysit doctor --auth [agent|all]` performs explicit checks, and `--refresh` bypasses the cache
3. **Docker container** — babysit starts a container with all four agent CLIs, common coding-agent tools, Google Chrome Stable, Puppeteer, Xvfb, Poppler, and qpdf preinstalled; credentials for every supported agent plus host `gh` auth are passed through, and your workspace is mounted at `/workspace`. With `--clone`, `/workspace` is a durable copy and the source is also mounted read-write at `/original` for explicit merge-back work
4. **Tmux session** — the container runs inside a tmux session that babysit attaches you to. Detach with Ctrl+B d to exit the cli; the agent and supervisor keep running in the background. Re-attach with `babysit open` from the original workspace, or `babysit open <id|name|number>` from anywhere. When the agent exits, an internal exit marker closes tmux promptly while Docker finishes its slower bookkeeping and credential-safe cleanup in the detached monitor. Terminal input is released before the resume hint so the foreground CLI can exit immediately
5. **Monitor daemon** — a detached background process watches the tmux output and takes actions based on your `babysit.yaml` rules. Outlives your foreground cli, so the agent stays supervised after you detach
6. **macOS caffeine** — on macOS, the monitor runs `caffeinate` while a session is active so the system does not sleep mid-run
7. **Credential sync** — mounted host credentials are refreshed in the background so long-running sessions and nested agent calls don't lose auth
8. **Resume state** — agent-native session history is kept in persistent Docker volumes, while a host-side registry keeps each Babysit ID, captured native agent ID, workspace, and launch settings. Run `babysit resume` to list history for the current workspace, or add `--all` to list every workspace, then resume Claude, Codex, Gemini, or OpenCode after its container exits

### Watchtower protection

Every Babysit agent container carries
`com.centurylinklabs.watchtower.enable=false` so compatible Watchtower releases
leave its stateful tmux session alone. Before starting a session, Babysit also
inspects running container names and images for Watchtower.

The compatibility list covers the established `containrrr/watchtower` image;
maintained forks from Nick Fedor, Beatkind, OpenSerbia, Storj, Marrrrrrrrry,
Torus Research, and Jauder Ho; Webhippie/Dockhippie builds; their confirmed
Docker Hub, GHCR, and Quay aliases; and Whefter's explicitly opt-in legacy
variant. Image tags, digests, and Docker Hub registry prefixes are normalized
before exact repository matching.

If a running container looks like Watchtower but its exact image repository is
not on that list, Babysit prints a prominent warning headed
`UNRECOGNIZED WATCHTOWER CONTAINER DETECTED` with its name and image. This
intentionally includes old high-pull images such as `centurylink/watchtower`
and `v2tec/watchtower`: their legacy builds may ignore the false opt-out label
and replace an active Babysit container.

## `babysit.yaml`

Created automatically on first run. Defines `on/do` rules — first match wins.
Generated examples are commented out until you configure and enable them.

```yaml
config:
    initial_prompt: |-
        You are running inside a Docker container — an isolated sandbox built for coding agents.
        ...
    idle_timeout_s: 300
    # commands:
    #     notify_command: >
    #         curl -f -X POST -d \
    #             "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input" \
    #             https://api.pushover.net/1/messages.json

babysit:

    # Send IDLE.md contents when the agent goes idle (create it first)
    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00

    # Notify when the agent asks for input
    # - on: choice
    #   do: notify_command
    #   timeout: 1:00:00

    # Notify on errors
    # - on: /error/i
    #   do: notify_command
    #   timeout: 05:00
```

`config.initial_prompt` is typed into the agent screen once the session starts.
New `babysit.yaml` files include Babysit's default launch prompt here. Existing
configs that omit it use the generated default prompt. Set it to `null` or `""`
to disable startup prompt typing. Clone sessions always append the clone safety
message, even when this setting is empty or custom. Babysit waits for each supported TUI's real
composer-ready screen, bracket-pastes the text, lets the paste handler settle,
then sends Enter exactly once. A changed or blocked screen times out without
sending the prompt early.

### `on:` triggers

| Trigger | Description |
|---|---|
| `idle` | No new output for `idle_timeout_s` seconds |
| `plan` | Agent is asking to accept a plan (detected per-agent) |
| `choice` | Agent is waiting for any user input |
| `"literal"` | Exact string match in last N lines of output |
| `/regex/flags` | Regex match in last N lines of output |

### `do:` actions

| Action | Description |
|---|---|
| `enter` | Press Enter |
| `accept` | Press Enter (semantic alias for accepting a choice) |
| `shift_tab` | Press Shift+Tab |
| `command_name` | Run a named command from `config.commands` |
| `"text"` | Type text and press Enter |
| `./file.md` | Send markdown file contents, splitting on `===` lines (waits for idle between segments) |

### `timeout:` format

Supports `SS`, `MM:SS`, or `HH:MM:SS`. Overrides `idle_timeout_s` per rule.

## Modes

| Flag | Workspace | Description |
|---|---|---|
| *(none)* | read-write mount | Default — full access |
| `--yolo` | read-write mount | Skip agent permissions, set `AGENT_AUTONOMY_MODE=yolo` |
| `--sandbox` | no mount | Ephemeral container, no host files |
| `--mudbox` | read-only mount | Agent can read but not modify files |
| `--clone` | copied workspace + original | Copy the current directory to `~/.babysit/clones/<session-id>`, mount it at `/workspace`, and mount the source at `/original` |
| `--docker` | *(additive)* | Mount the host Docker socket so Docker commands can run from inside the Babysit container |
| `--ignore-host-agents-md` | *(additive)* | Keep host-global agent instructions, skills, and preferences out of the container; credentials remain available |
| `--port PORT` | *(additive)* | Publish a host port to the same container port |
| `--port HOST:CONTAINER` | *(additive)* | Publish a host port to a different container port |
| `--loop` | *(additive)* | Override `on: idle` with `./LOOP.md` or `~/.agents/LOOP.md` or "Keep going" |

Modes combine: `--mudbox --yolo --loop` gives a read-only workspace with max autonomy and loop. `--clone` cannot combine with `--sandbox` or `--mudbox`. Clone launches from inside a Docker-enabled Babysit session are also rejected because the host clone root is not available reliably.

### Clone mode

`--clone` copies the complete current directory, including hidden files,
symlinks, `node_modules`, and other dependency folders. The copy is prepared
transactionally and kept at `~/.babysit/clones/<session-id>` until explicitly
pruned.
Babysit prints its path at launch and shows it in resume history.

For a standalone Git repository root, the copy checks out
`babysit/<name>-<session-id>` or `babysit/<session-id>` when no `--name` is
given. Spaces and unsafe ref characters in the name become dashes. The source
repository's branch and refs are not changed. Git remotes remain configured in
the copy, so Babysit warns that a push still targets the same remotes. Linked
worktrees and repositories whose Git metadata lives outside the copied folder
are rejected. Starting from a repository subdirectory copies it as a plain
folder and prints a warning.

Before copying, Babysit reports how many live agents already use clones of the
same source. If a live non-clone agent is editing the source, Babysit warns and
asks `Continue with --clone? [Y/n]`. Non-interactive launches fail closed unless
`--yes` is passed.

`babysit resume <id>` reuses the same clone, branch, and clone-local config. A
detached live tmux session is simply reattached; if its monitor died, Babysit
restarts it. After an abrupt shutdown, Babysit stops and finalizes any surviving
container before launching the agent again. If `/original` disappeared but the
clone remains, resume warns and asks before continuing without that mount.
Clone paths are never pruned automatically.

`babysit prune` reports how many managed clones exist, then asks whether to
remove copies unused for 30 days (the default), every copy not in use, or copies
older than a custom number of days. It previews the matching copies and their
combined size, then requires an explicit `[y/N]` confirmation. Live tmux,
monitor, container, and launch activity is excluded. Clones with pending
recovery, unreadable contents, nested mounts, uncertain activity, or invalid
ownership metadata are also protected.

`babysit prune --list` is noninteractive and lists every managed clone with its
name, ID, last-use date, age, status, allocated directory size, and path. Size
counts the clone directory only; Docker volumes and container layers are not
included. Unknown folders in the clone root are reported but never deleted.
Interrupted confirmed prunes resume safely the next time interactive prune runs.

Use `--ignore-host-agents-md` when a session should see the repository's own
instructions without inheriting your host coding-agent profile. It omits the
host `~/.agents` directory, native global instruction files such as
`CLAUDE.md`, global skills, and host model/tool/MCP preferences. Babysit still
supplies agent and GitHub credentials, retains only the minimal authentication
and first-run state needed by each CLI, and keeps project-local files under
`/workspace` available. The setting is saved with the session and restored by
both `babysit resume` forms. Executable host setup from `~/.babysitrc` is also
skipped; credentials must come from the supported agent files, keychains, or
environment variables when isolation is enabled. GitHub CLI authentication is
injected into a private credential-only profile containing host, account, and
token state instead of mounting aliases or other gh preferences. Babysit
uploads that profile, generated agent configuration, credential files, and a
literal credential-environment bootstrap to a stopped container through the
Docker API. Short-lived config/bootstrap copies are deleted after Docker
acknowledges them. Secret values stay out of Docker `Config.Env`/inspect and
bind-mount metadata; environment values are imported only by the entrypoint.
Long-running OAuth files retain a private sync copy and remain synchronized
through `docker cp`; after the agent exits, the monitor performs one final
credential pull before removing the stopped container. This client-side
transport also works through nested Docker daemons. The foreground sync connects
before the container starts and completes its final pull before the detached
monitor takes ownership, so fast exits and handoff races cannot skip a refresh.
If a final pull fails, Babysit stops and retains the container plus private sync
files instead of discarding the only potentially valid rotated credential. A
recovery marker under `~/.babysit/credential-recovery` protects that state from
stale cleanup from initial credential capture onward, including auth checks
before the main container exists. macOS Keychain-backed handoffs reuse the same
credential baseline when the monitor takes ownership. Signal cleanup still
removes containers holding only static secrets because they have no refreshable
state to recover.

An already-running unisolated session cannot be upgraded in place because its
mounts already exist. `babysit resume <id> --ignore-host-agents-md` refuses to
attach in that case; exit the running session and resume it again to apply the
isolation boundary.

`--docker` uses Docker-outside-of-Docker: Babysit mounts the host Docker socket,
sets `DOCKER_HOST`, and installs the Docker CLI in the agent image. Docker
commands run inside the session create sibling containers on the host daemon.
On macOS, Babysit also recognizes Docker Desktop's user-scoped socket
(`~/.docker/run/docker.sock`) and the active Docker context when
`/var/run/docker.sock` is not present. For nested Babysit testing,
`BABYSIT_HOST_WORKSPACE` preserves the original host path so inner containers
can bind-mount the same project correctly.

Because Docker socket access can create containers with host bind mounts,
`--docker --sandbox` and `--docker --mudbox` weaken those modes. Babysit warns
and requires an explicit `Y` before starting those combinations, except in YOLO
mode where confirmations are skipped.

Use `--port` to publish services running inside the Babysit container. `--port
80` maps host port `80` to container port `80`; `--port 663:12345` maps host
port `663` to container port `12345`. Repeat `--port` to publish multiple
ports.

## Bundled agent tools

The image includes small tools that coding agents commonly need across projects:

- Native builds and source work: `pkgconf`/`pkg-config`, `shfmt`, Universal
  Ctags, and `git filter-repo`
- Runtime and filesystem diagnosis: `pstree`, `fuser`, `killall`, `socat`,
  `getfacl`, `setfacl`, `inotifywait`, `inotifywatch`, and `entr`
- PDF structure checks and transformations: `qpdf`

## Browser automation

The container includes the latest Google Chrome Stable and a global Puppeteer
install. Puppeteer is configured to reuse `/usr/bin/google-chrome-stable`, so
installing Puppeteer inside a project does not download a second Chrome or the
legacy Headless Shell. Both CommonJS and ESM scripts can import the bundled
package directly:

```js
import puppeteer from 'puppeteer'

const browser = await puppeteer.launch()
const page = await browser.newPage()
await page.goto( `https://example.com` )
await browser.close()
```

Puppeteer defaults to headless mode and needs no virtual display. For headful
Chrome, launch with `headless: false` and run the script through Xvfb:

```bash
xvfb-run -a --server-args="-screen 0 1920x1080x24 -nolisten tcp" node browser.js
```

The image also includes `x11-utils` for display diagnostics and Poppler's
`pdfinfo`, `pdftotext`, `pdftoppm`, and `pdftocairo` tools for inspecting or
rendering PDFs. Use `qpdf --check file.pdf` for structural validation and qpdf's
other commands for content-preserving transformations.

Babysit gives each container a 1 GB `/dev/shm` ceiling for browser renderer
stability. Chrome runs as the non-root `node` user with its sandbox enabled;
do not add `--no-sandbox` when browsing untrusted pages. Babysit retains
Docker's syscall allowlist, adding only the `clone` and `unshare` calls Chrome
needs for user, PID, and network sandbox namespaces. Each launch uses a private,
short-lived profile path; every container is created before tmux starts it, so
the profile is deleted only after Docker acknowledges it. Babysit does not
grant the broad `SYS_ADMIN` capability. Docker namespace,
capability, AppArmor, and seccomp boundaries remain active. The separate legacy
`chrome-headless-shell` binary is intentionally not bundled.

## Loop mode

With `--loop`, the idle action is overridden. Babysit looks for instructions in order:

1. `./LOOP.md` in the current directory
2. `~/.agents/LOOP.md` global fallback
3. `"Keep going"` hardcoded default

With `--ignore-host-agents-md`, step 2 is intentionally skipped; a project
`./LOOP.md` still works, otherwise Babysit uses `"Keep going"`.

Use `===` lines in LOOP.md to split into segments executed between idle periods:

```markdown
/clear
===
Check for bugs
===
Check if the specification is fully implemented
```

Use `%initial_prompt%` in `LOOP.md` to paste the configured
`config.initial_prompt`:

```markdown
%initial_prompt%
===
Keep going
```

## Dependency isolation

By default, babysit mounts `node_modules` and `.venv` as named Docker volumes instead of bind-mounting the host copies. This avoids cross-platform binary mismatches (host macOS binaries vs container Linux). Disable with:

```yaml
config:
    isolate_dependencies: false
```

## Host configuration

Authentication policy and cache metadata live under `~/.babysit`. Startup
always checks the active agent, then checks supported non-active agents whose
CLI exists on host PATH. Cache misses run concurrently and successful checks
are cached for 12 hours. Entries contain timestamps and SHA-256 fingerprints
only—never tokens or model output—and miss when an agent's credentials,
effective route, `.babysitrc`, or local Docker image changes. Each throwaway
probe receives only its own credential descriptors and minimal provider/account
config; the real session still receives all captured agent credentials.
OpenCode probes pin the session's effective model, stage the same sanitized
provider route, and use a tool-free profile so unsupported tool schemas cannot
masquerade as a missing login. OpenCode's opaque server-error wrapper is retried
once within the same probe deadline; error-level logs preserve the underlying
diagnostic when both attempts fail. Concurrent launches share an auth lease, so
one launch verifies while waiters reuse its reconciled credential rotation and
warm results.

```bash
babysit doctor --auth             # all supported agents
babysit doctor --auth codex       # one agent
babysit doctor --auth --refresh   # force real checks
```

Older `auth_check_agents` configuration remains readable for compatibility but
is deprecated and ignored by startup and `doctor`.

Set `BABYSIT_DEBUG=1` to print phase timings for dependency checks, startup,
authentication probes, tmux attachment, and detached shutdown cleanup. If a
startup prompt readiness check times out, it also prints the final blocked TUI
screen. An explicit `LOG_LEVEL` or `LOGLEVEL` still takes precedence.

If `~/.babysitrc` exists, Babysit bind-mounts it read-only into the container
and sources it as the `node` user immediately before launching the coding
agent. Isolated sessions started with `--ignore-host-agents-md` skip this file
because arbitrary shell setup cannot be separated safely into credentials and
preferences. Use it for host-local environment setup:

```bash
OPENAI_API_KEY=...
export CUSTOM_TOOL_HOME="$HOME/.custom-tool"
```

Plain `KEY=value` assignments and `export KEY=value` lines are both available
in the coding agent's environment.

## Subcommands

```
babysit <agent> [flags]              Start a new session
babysit <agent> resume <id> [flags]  Resume a previous session
babysit list [--all]                 List active sessions and launch flags
babysit open [id|name|number]        Attach to an active session
babysit resume [session_id] [flags]  List this workspace's sessions or resume one
babysit prune [--list]               Remove unused clone workspaces
babysit config                       Configure babysit settings
babysit update                       Refresh babysit, ~/.agents, and the docker image
```

Run `babysit open` without an id from a workspace directory to attach to its
only active session. When more than one active session belongs to that
directory, Babysit shows the matching rows with the same numbers used by
`babysit list`.

Give a session a memorable label with `babysit <agent> --name "feature 1"`.
`babysit list` numbers every active session and shows its name (or ID when
unnamed), agent `running`/`idle` status, tmux attachment status, coding agent,
launch flags (for example `yolo,docker`), and the deepest two levels of its
working directory. Sessions without recorded flags show `-`. Activity comes
from the captured tmux viewport: changes show `running`, while one complete
monitor interval without a change shows `idle`. This is independent from
Babysit's idle supervision timeout. Add `--all` to include the separate ID and
full tmux session name. Run `babysit open <number>` from any directory to open
that numbered row, or `babysit open "feature 1"` to open an active session by
its exact name. Quote names containing spaces.

Run `babysit resume` without a session id to list persistent Babysit-managed
history, newest first. When the current workspace has history, only its sessions
are shown; otherwise the full registry remains visible. Add `--all` to always
show every workspace. Each row shows the canonical Babysit ID alongside the
captured native Codex, Claude, Gemini, or OpenCode session ID. Use the Babysit ID
with `babysit resume <session_id>` so Babysit can restore the original agent,
workspace, modes, ports, and name. Clone sessions restore their durable copy;
other sessions restore the original workspace. If Babysit did not capture a
native agent ID before exit, it resumes the latest agent session from the
restored workspace.

Unrecognised flags are passed through to the coding agent CLI:

```bash
babysit claude --yolo --model sonnet --effort high
```

By default, Babysit starts Claude with `--model best --effort xhigh` and Codex
with `--model gpt-5.6-sol -c model_reasoning_effort="xhigh"`. OpenCode follows
an explicit `--model` first, then its configured literal model, then a frontier
model through the authenticated provider. OpenAI uses `openai/gpt-5.6-sol`;
OpenRouter uses `openrouter/openai/gpt-5.6-sol`. Other providers retain
OpenCode's own selection unless configured explicitly. Stored credentials and
literal API keys in mounted provider config are detected without exposing their
values. Models or keys resolved inside the container through `.babysitrc`, a
project `.env`, or an `{env:...}` / `{file:...}` config template remain unpinned
so OpenCode can resolve them itself.

## Logging tmux output

Pass `--log` to append everything the tmux pane renders to a logfile. The header `Babysit session start: YYYY-MM-DD HH:MM:SS` is prepended to each session's block, so several runs can share one file.

```bash
babysit claude --log                            # default path: .YYYY_MM_DD_HH_MM.babysit.log in cwd
babysit claude --log=babysit.log                # custom path (relative to cwd)
babysit claude --log ~/.logs/babysit.log        # absolute path; ~ expanded
```

The log is **append-only** — it is never truncated, so it's safe to point multiple sessions at the same file. tmux writes raw pane bytes including ANSI color/cursor sequences; for a plain-text view pipe through `sed -E 's/\x1B\[[0-9;?]*[a-zA-Z]//g'` or open with `less -R`.

## Self-update

Updates are explicit. Run `babysit update` to refresh everything in one sweep:

1. `git pull` on the babysit repo (or download the latest GitHub-release binary, for compiled installs)
2. `git pull` on `~/.agents` (if it exists)
3. `docker pull` the latest container image, refreshing the bundled coding agents, browser stack, document tools, and agent toolchain
4. Upgrades each host-installed agent CLI (`claude`, `codex`, `gemini`, `opencode`) using the agent's built-in self-update if available, otherwise the matching package manager (npm or brew, auto-detected from the binary's install path). Agents not on PATH are skipped.

## Building from source

Requires [Bun](https://bun.sh):

```bash
npm install
npm run build
```

Produces static binaries in `dist/` for linux-x64, linux-arm64, darwin-x64, darwin-arm64.

## Testing

```bash
bun test
npm run test:e2e
npm run test:all
```

`npm run test:e2e` builds a local Babysit image, derives a fake-agent image
from it, then starts real Docker/tmux sessions to verify startup prompts,
resume handoff, monitor actions, logging, nested Docker, mount modes,
dependency isolation, and credential sync without calling model APIs.

For faster repeat runs with an existing base image:

```bash
BABYSIT_E2E_BASE_IMAGE=actuallymentor/babysit:latest \
BABYSIT_E2E_SKIP_BASE_BUILD=1 \
npm run test:e2e
```

## License

MIT
