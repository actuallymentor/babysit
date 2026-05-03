# babysit

A supervisor for LLM coding agent CLIs. Runs [Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Gemini](https://github.com/google-gemini/gemini-cli), and [opencode](https://github.com/sst/opencode) inside Docker containers with tmux session management and declarative supervision rules.

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

# Gemini with read-only workspace
babysit gemini --mudbox

# Resume a previous session
babysit resume <session_id> --yolo

# List active sessions
babysit list

# Attach to a running session
babysit open <session_id>
```

## How it works

1. **Docker container** — babysit starts a container with all four agent CLIs preinstalled, your credentials passed through, and your workspace mounted at `/workspace`
2. **Tmux session** — the container runs inside a tmux session that babysit attaches you to. Detach with Ctrl+B d to exit the cli; the agent and supervisor keep running in the background. Re-attach with `babysit open <id>`
3. **Monitor daemon** — a detached background process watches the tmux output and takes actions based on your `babysit.yaml` rules. Outlives your foreground cli, so the agent stays supervised after you detach
4. **Credential sync** — host credentials are refreshed in the background so long-running sessions don't lose auth

## `babysit.yaml`

Created automatically on first run. Defines `on/do` rules — first match wins.

```yaml
config:
    idle_timeout_s: 300
    commands:
        notify_command: >
            curl -f -X POST -d \
                "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input" \
                https://api.pushover.net/1/messages.json

babysit:

    # Send IDLE.md contents when the agent goes idle
    - on: idle
      do: ./IDLE.md
      timeout: 30:00

    # Notify when the agent asks for input
    - on: choice
      do: notify_command
      timeout: 1:00:00

    # Notify on errors
    - on: /error/i
      do: notify_command
      timeout: 05:00
```

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
| `shift_tab` | Press Shift+Tab (plan acceptance in Claude) |
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
| `--loop` | *(additive)* | Override `on: idle` with `./LOOP.md` or `~/.agents/LOOP.md` or "Keep going" |

Modes combine: `--mudbox --yolo --loop` gives a read-only workspace with max autonomy and loop. The exception is `--sandbox` and `--mudbox` together — they describe contradictory mount strategies, so babysit rejects the combination.

## Loop mode

With `--loop`, the idle action is overridden. Babysit looks for instructions in order:

1. `./LOOP.md` in the current directory
2. `~/.agents/LOOP.md` global fallback
3. `"Keep going"` hardcoded default

Use `===` lines in LOOP.md to split into segments executed between idle periods:

```markdown
/clear
===
Check for bugs
===
Check if the specification is fully implemented
```

## Dependency isolation

By default, babysit mounts `node_modules` and `.venv` as named Docker volumes instead of bind-mounting the host copies. This avoids cross-platform binary mismatches (host macOS binaries vs container Linux). Disable with:

```yaml
config:
    isolate_dependencies: false
```

## Subcommands

```
babysit <agent> [flags]              Start a new session
babysit <agent> resume <id> [flags]  Resume a previous session
babysit list                         List active sessions
babysit open <session_id>            Attach to an active session
babysit resume <session_id> [flags]  Resume a previous session
```

Unrecognised flags are passed through to the coding agent CLI:

```bash
babysit claude --yolo --model sonnet --effort high
```

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
3. `docker pull` the latest container image
4. Upgrades each host-installed agent CLI (`claude`, `codex`, `gemini`, `opencode`) using the agent's built-in self-update if available, otherwise the matching package manager (npm or brew, auto-detected from the binary's install path). Agents not on PATH are skipped.

## Building from source

Requires [Bun](https://bun.sh):

```bash
npm install
npm run build
```

Produces static binaries in `dist/` for linux-x64, linux-arm64, darwin-x64, darwin-arm64.

## License

ISC
