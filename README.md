# babysit

Run LLM coding agents in durable Docker and tmux sessions. Babysit keeps them
alive after you detach, restores their sessions, and responds to terminal output
with simple rules.

Supports [Claude](https://docs.anthropic.com/en/docs/claude-code),
[Codex](https://github.com/openai/codex),
[Gemini](https://github.com/google-gemini/gemini-cli), and
[OpenCode](https://github.com/anomalyco/opencode). Gemini supports enterprise
Code Assist and API-key accounts; individual Google accounts require
Antigravity.

## Install

Requires macOS or Linux, Docker, tmux, and Git.

```bash
curl -fsSL https://raw.githubusercontent.com/actuallymentor/babysit/main/scripts/install.sh | bash
```

The installer puts `babysit` in `~/.local/bin` without sudo.

## Start

```bash
babysit claude --yolo
babysit codex --clone --name "feature 1"
babysit codex --sandbox --loop
babysit gemini --mudbox
```

Detach with `Ctrl+B d`. Reattach with `babysit open`. Unrecognized flags pass
through to the agent:

```bash
babysit claude --yolo --model sonnet --effort high
```

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
`--docker` weakens their isolation because the Docker socket controls the host
daemon.

## Sessions

| Command | Result |
|---|---|
| `babysit list` | List active sessions |
| `babysit list --all` | Include IDs and tmux names |
| `babysit open [id\|name\|number]` | Attach to an active session |
| `babysit resume` | List this workspace's session history |
| `babysit resume --all` | List history from every workspace |
| `babysit resume <id> [flags]` | Restore a Babysit session |
| `babysit prune --list` | Show managed clone usage |
| `babysit prune` | Remove unused clones interactively |
| `babysit doctor --auth [agent]` | Verify agent authentication |
| `babysit update` | Update Babysit, agent tools, and the image |

Use `--log[=PATH]` to append raw tmux output to a file. Run `babysit --help` for
the complete CLI reference.

## Supervision

The first run creates `babysit.yaml`. Rules are evaluated from top to bottom;
the first match wins.

```yaml
config:
    idle_timeout_s: 300
    # commands:
    #     notify: notify-send "Babysit needs input"

babysit:
    # Uncomment only the rules you want.
    # - on: plan
    #   do: accept
    #   timeout: 10

    # - on: choice
    #   do: notify
    #   timeout: 1:00:00

    # - on: idle
    #   do: ./IDLE.md
    #   timeout: 30:00
```

Triggers: `idle`, `plan`, `choice`, a quoted literal, or `/regex/flags`.

Actions: `enter`, `accept`, `shift_tab`, a configured command, text to submit,
or a Markdown file. Split Markdown workflows on `===` to wait for idle between
steps. Timeouts accept `SS`, `MM:SS`, or `HH:MM:SS`.

`--loop` uses the first available instruction source:

1. `./LOOP.md`
2. `~/.agents/LOOP.md`
3. `Keep going`

## Mobile web companion

Initialize the host bridge and print its access token:

```bash
babysit web init
```

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

The production proxy must preserve the original host, `X-Forwarded-Proto`, and
`X-Forwarded-For`. To move the bridge, set `BABYSIT_WEB_BRIDGE_DIR` to the same
absolute path for both Babysit and Compose.

## Runtime

- The agent runs as a non-root user in a Docker container inside tmux.
- A detached monitor applies `babysit.yaml` rules and keeps credentials in sync.
- Agent state lives in persistent Docker volumes. Babysit metadata lives under
  `~/.babysit`.
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
npm run build
bun test
npm run test:e2e
```

`npm run build` creates static Linux and macOS binaries in `dist/`. The E2E
suite exercises real Docker and tmux sessions without calling model APIs.

See [SPECIFICATION.md](SPECIFICATION.md) for the design contract and
[CHANGELOG.md](CHANGELOG.md) for release history.

## License

MIT
