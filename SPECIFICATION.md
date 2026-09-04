This cli is called `babysit`. It is designed as a supervisor for LLM coding agent clis like `claude`, `codex`, `gemini`, and `opencode`. It is the spiritual successor of [sir-claudius](https://github.com/actuallymentor/sir-claudius). You should clone and read the claudius source code to learn from the lessons of that project timeline. You do NOT have to implement all sir-claudius features.

In order to implement the coding agents properly, you will need to browse the web for their documentation.

The core functionality is that when run, `babysit` will:

- Run subcommands in a tmux session, so that the user can detach and re-attach to the session as needed
- The babysit tmux sessions have their own -L, have history set to 10000, have `set -g mouse on`, and are named `babysit_$(pwd)_<agent_name>_<timestamp>` for easy identification. Each new session has a bottom, session-local status bar showing its optional name, the parent/current original working directory, and launch modifiers in `[flag, flag]` form
- Start a `babysit` docker container that will contain the LLM coding agent cli
- The container mounts the current PWD in /workspace, so the LLM coding agent cli can read/write files in the current directory. With `--clone`, it instead mounts a durable copy from `~/.babysit/clones/<session-id>` at `/workspace` and mounts the original PWD read-write at `/original` for explicit merge-back work
- By default, mounts the host ~/.agents to the container ~/.agents. With `--ignore-host-agents-md`, host-global agent instructions, skills, loop instructions, and preferences are omitted while credentials remain available.
- The container installs the dependencies that sir-claudius has in the image as well (look at that dockerfile), plus common coding-agent tools including fzf, pkgconf, psmisc, socat, ACL/inotify utilities, entr, shfmt, git-filter-repo, Universal Ctags, qpdf, the latest multi-arch Google Chrome Stable, globally importable Puppeteer configured to reuse that browser, Xvfb/X11 utilities for headful automation, and Poppler PDF utilities
- Start the coding agent in the container
- Importantly, the container has passwordlless sudo, and has all coding clis preinstalled, with the host credentials for these agents passed through in a platform-specific manner (we support OSX and Ubuntu Linux)
- Run mode is passed to the container through the environment variable AGENT_AUTONOMY_MODE, which can be `sandbox`, `mudbox`, `yolo`, or empty for default. The system prompt of the coding agent is configured based on this mode to give the agent appropriate instructions and limitations.
- The `babysit` cli monitors the content of the sessions and provides input based on `babysit.yaml`, a file the cli creates on first run in the current directory. The instructions there are "first one wins" when there are conflicts.
- The `babysit.yaml` file has `config` and `babysit` sections. The `config` section contains configutations about behavior. The `babysit` section contains the actions that `babysit` takes depending on the output (or idle) of the tmux session with the coding agent. The `babysit:` section contains `on/do` pairs where `on` can be a keyword, a literal string, or a regex. The `do` can be a command defined in the `config:` section, a literal string, or a markdown file. In both string and markdown cases, sections may be defined using `===` segments, which instructs `babysit` to wait for idle after executing each segment. This allows the user to create complex instructions that are executed step by step when the agent is idle in between.
- The `on:` keyword options are: idle, plan, choice, literal string, and regex. Idle means "no new output in the tmux session for longer than the timeout". Plan means the agent is asking the user to accept a plan, this is detected through a matching table (like a patterns.js kind of file with agent>regex pairings) that `babysit` keeps per coding agent. Choice means the agent is waiting for user input other than accepting a plan, this is also detected through a matching table. Literal string matching works on the latest output going back N lines (this is a config variable set to 10 by default). Regex matching also works on the latest output with a separate lines config.

The generated `babysit.yaml` has the following shape. The full mode-aware launch prompt replaces the abbreviated `initial_prompt` content below. Commands and supervision rules are examples only; users explicitly uncomment and configure the ones they want.

```yaml
# babysit.yaml

# Babysit configuration
config:
    initial_prompt: |-
        You are running inside a Docker container — an isolated sandbox built for coding agents.
        ...
    idle_timeout_s: 300 # The amount of seconds of inactivity (no output in the tmux session) that count as `on: idle`

    # Named shell commands are opt-in. Uncomment and configure before use.
    # commands:
    #     notify_command: >
    #         curl -f -X POST -d \
    #             "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input&url=&priority=0" https://api.pushover.net/1/messages.json

# Babysit instructions
babysit:

    # Format:
    # - on: <event> # unquoted words are special keywords, quotes words are literal matches, regex is supported with /regex/flags. Note that the `on:` only triggers if the match is the latest seen output for longer than the timeout
    #   do: <action> # unquoted words are special keywords or commands specified in config.commands, quoted words are literal input followed by and enter keystroke

    # Examples are disabled until you uncomment and configure them.

    # Send a markdown workflow when the coding agent is idle.
    # - on: idle # this means no new output in the tmux session
    #   do: ./IDLE.md # create this file first; relative and absolute paths work
    #   timeout: 30:00 # overrides idle_timeout_s; SS, MM:SS, or HH:MM:SS

    # This instructs babysit to accept any plan that the coding agent submits by pressing "enter" when it encounters a plan acceptance step
    # - on: plan # this means the coding agent is asking the user to accept a plan
    #   do: enter
    #   timeout: 10 # waits 10 seconds

    # Run the configured notification command when the agent needs input.
    # - on: choice
    #   do: notify_command
    #   timeout: 1:00:00

    # - on: /error/i
    #   do: notify_command
    #   timeout: 05:00
```

## Coding agent configuration

The coding agent is provided this system prompt:

```
You are running inside a Docker container — an isolated sandbox built for coding agents. You have passwordless sudo for any operation that needs root, this is safe for you to use at will. Your workspace is /workspace (bind-mounted from the host). Always read ~/.agents/AGENTS.md if it exists.

Google Chrome, Puppeteer, and Xvfb are preinstalled for browser automation; Poppler's `pdfinfo`, `pdftotext`, `pdftoppm`, and `pdftocairo` commands plus `qpdf` are available for PDFs. Import `puppeteer` from Node.js; its default headless mode works directly. For headful Chrome, launch with `headless: false` and run the script through `xvfb-run -a`. Never add `--no-sandbox`.

Common build, process, filesystem, and code tools are also preinstalled: `pkgconf`/`pkg-config`, `pstree`, `fuser`, `killall`, `socat`, `getfacl`, `setfacl`, `inotifywait`, `inotifywatch`, `entr`, `shfmt`, `git filter-repo`, and Universal Ctags (`ctags`, `ctags-universal`, and `readtags`).

Do NOT add Co-Authored-By lines to git commit messages. The git author identity is already configured via environment variables.
```

In sandbox mode this is APPENDED:

```
You are running in SANDBOX mode (AGENT_AUTONOMY_MODE=sandbox). There is no workspace mounted — the /workspace directory is empty and container-local. All host files are mounted read-only. You cannot modify anything on the host. Use this session for general questions, research, brainstorming, or tasks that don't need access to a project."
```

In mudbox mode this is APPENDED:

```
You are running in MUDBOX mode (AGENT_AUTONOMY_MODE=mudbox). The workspace at /workspace is mounted READ-ONLY from the host. You can read and explore all project files but cannot modify them. Use this mode for code review, analysis, exploration, or generating patches. Any files you need to create must go in a container-local directory outside /workspace.
```

In clone mode this is APPENDED, including when `initial_prompt` is empty or custom:

```
You are running in CLONE mode. /workspace is a copy of /original. Work in /workspace. You may only touch /original when the user gives explicit instructions to do so.
```

In yolo mode this is APPENDED:

```
You are running in YOLO mode (AGENT_AUTONOMY_MODE=yolo). The environment variable AGENT_AUTONOMY_MODE is set to 'yolo'. In this mode you are expected to act with maximum autonomy — fulfill the user's intent with as little interaction as possible. Do not ask for confirmation before taking actions. Prefer doing over asking. If a task is ambiguous, make a reasonable choice and proceed. Commit your work without confirmation.
```

With `--ignore-host-agents-md` this is APPENDED:

```
Host-global coding-agent instructions, skills, and preferences are intentionally unavailable in this session. Project-local instructions inside /workspace still apply, and host credentials are still available for authentication.
```

## Feature flags:

`--yolo` add --dangerously-skip-permissions or equivalent flag to the coding cli, also inject AGENT_AUTONOMY_MODE='yolo' into the container env. Also passes adds the following to the system prompt of the agent: `
`--sandbox` do not mount any host directory into the container, the fs inside the container is ephermal
`--mudbox` mount the current pwd as read only, so the coding agent can read files but not write them
`--clone` transactionally copy the full current PWD, including hidden files, symlinks, and dependency folders, to `~/.babysit/clones/<session-id>`; mount the copy read-write at `/workspace` and the original read-write at `/original`. Reject combinations with sandbox/mudbox and nested Babysit Docker launches
`--ignore-host-agents-md` omit host-global agent instruction files, skills, loop instructions, executable `~/.babysitrc` setup, and preferences while retaining credentials from supported agent files, keychains, and environment variables, minimal authentication state, and project-local instructions under `/workspace`; sanitized GitHub profiles are uploaded to a stopped container through `docker cp` before launch so profile host/account tokens do not enter Docker environment or bind-mount metadata
`--loop` overrides the `on: idle` in the babysit.yaml to run `./LOOP.md` if it exists, otherwise `~/.agents/LOOP.md` if it exists, otherwise it types "Keep going" into the session. Example `LOOP.md`, note that === lines denote "wait for idle" within the `LOOP.md` execution:

```
/clear
===
Check for bugs
===
Check if the specification is fully implemented
```

## Example usage commands

`babysit claude --yolo` - starts a claude session, sets AGENT_AUTONOMY_MODE to yolo, and configures the system prompt and sets "dangerously skip permissions" or equivalent for maximum agent autonomy.
`babysit codex --sandbox --loop` - starts a codex session in sandbox mode, so no host files are mounted and the agent is fully isolated, adds mudbox info to the system prompt. Also configures the babysit instructions to run either `./LOOP.md` or `~/.agents/LOOP.md` or "Keep going" every time the agent is idle.
`babysit codex --name "feature 1"` - starts a named session. The name is shown by `babysit list` and can be used with `babysit open "feature 1"`.
`babysit codex --clone --name "feature 1"` - copies the current directory into a durable clone and, for a standalone Git root, checks out `babysit/feature-1-<session-id>` without changing the source repository refs.
`babysit prune` - reports the managed clone count and interactively prunes copies unused for 30 days by default, all copies not in use, or copies older than a custom whole number of days. It previews candidates and requires explicit default-no confirmation.
`babysit prune --list` - noninteractively lists all managed clone copies with their allocated directory sizes, last-use times, status, and paths.
`babysit codex --ignore-host-agents-md` - starts a codex session without host-global agent instructions, skills, or preferences. Host credentials remain mounted, and project-local instructions inside `/workspace` still apply.
`babysit gemini --mudbox --yolo` - starts a gemini session in mudbox mode, so the current directory is mounted read-only and the agent can explore files but not modify them. Also sets AGENT_AUTONOMY_MODE to yolo, sets system prompt accordingly, and sets dangerourly skip permissions or equivalent for maximum agent autonomy.
`babysit opencode resume xxxx-xxxx-xxxx-xxxx --yolo` - resumes a opencode session with the given id, in yolo mode (AGENT_AUTONOMY_MODE=yolo, system prompt configured accordingly, and maximum agent autonomy permissions enabled).

## Feature list in no particular order

- git user information is passed from the host to the container, defaults are set like in the sir-claudius Dockerfile, but the author is "Babysitter" for both author and committer name by default, also swap the repos of course
- when a babysit session is exited, the babysit manager prints `To resume this session, run:` followed by `babysit resume <session_id>` on its own line (no backticks, no quoting — so it's triple-click selectable). This will require `babysit` to get the session id after starting, as it cannot easily grab it after the session was closed
- session close returns promptly when the supervised agent exits. Babysit's container entrypoint emits an internal exit marker, the monitor closes tmux, and Docker stop detection plus the final credential pull/removal continue in the detached cleanup owner
- normal startup verifies the active coding agent plus supported non-active CLIs installed on the host. Uncached checks run concurrently and receive only their own credentials plus auth-relevant provider/account state; successful checks are cached for 12 hours against hash-only auth inputs and immutable image identity. OpenCode checks pin the effective model/provider route and disable tools, while login failures remain distinct from model/configuration failures. Concurrent launches serialize capture/check/reconciliation so one-use refresh tokens cannot race. Enter skips the entire interactive auth decision, non-interactive misses verify and fail closed, and `babysit doctor --auth [agent|all] [--refresh]` remains exhaustive
- startup prompt injection waits for a verified per-agent composer-ready screen, bracket-pastes the message, lets paste handling settle, and sends Enter exactly once. Loading, update, onboarding, authentication, provider-selection, and model-error screens time out without receiving the prompt; resume never injects it again
- clone launches report other live clones of the source. A live non-clone editor requires a default-yes `[Y/n]` confirmation; non-interactive use requires `--yes`. Clone copies are retained until explicitly pruned, preserve Git remotes with a warning, reject external Git metadata/worktrees, and treat repository subdirectories as plain folders with a warning
- clone session metadata is written atomically before Docker launch. Resume reuses the clone and clone-local config, restarts a missing monitor for live tmux sessions, and finalizes a surviving container before relaunch after abrupt shutdown. A missing original requires a warning and `[Y/n]` confirmation, then resumes without `/original`; a missing clone is fatal
- clone pruning deletes only complete direct-child workspaces with matching external ownership manifests. Live tmux/monitor/container/launch activity, pending recovery, failed liveness checks, the caller's current directory, unreadable trees, nested filesystems, malformed metadata, and unmanaged entries are excluded. Age uses the newest launch/end/record timestamp across the clone family. Deletion acquires the clone lock, rechecks eligibility, journals an atomic same-filesystem quarantine rename, marks every family session pruned, and can finish an interrupted confirmed prune on the next interactive run
- `babysit resume` without an id lists persistent Babysit-managed session history newest first, including each Babysit ID, coding agent, captured native Codex/Claude session ID, start time, and workspace. When the current workspace has history, only its sessions are shown; otherwise the full registry remains visible. `babysit resume --all` always shows every workspace. The Babysit ID is the canonical resume selector because it restores the agent and launch context.
- `babysit list` command to list and number active sessions with name-or-id, coding-agent `running`/`idle` status, tmux attachment status, agent, comma-separated launch flags, and the deepest two working-directory levels. Sessions without recorded flags show `-`. `babysit list --all` also shows the separate session ID and full tmux session name.
- Detaching from a newly launched session, `babysit open`, or a live `babysit resume` prints the normal `babysit list` output when the tmux session remains active. Natural agent exits retain the resume hint without an active-session list.
- `babysit open <session_id|name|number>` command to open a tmux session attached to the given session id, exact human-readable name, or numbered row from `babysit list`. With no selector it attaches to the only active session for the current directory; when several match, it prints those sessions with their global list numbers so they can be selected with `babysit open N`. Note that `babysit resume` is used to resume exited sessions and uses the session id as the coding agent knows it, but `babysit open` is used to connect to active tmux sessions.
- Babysit checks that all dependencies are installed before commands that launch or attach to sessions. Local metadata-only commands such as bare `babysit resume` do not require Docker or tmux. Updates are explicit: `babysit update` runs git pull on the babysit repo, git pull on ~/.agents if it exists, pulls the latest docker image (including the refreshed in-container agent, browser, and document toolchain), and upgrades each host-installed coding agent CLI (skipping any that aren't on PATH)
- For common dependency folders like `node_modules` or `.venv`, babysit does not mount the host folder but mounts a docker volume specific to this folder, which has caching. See the sir-claudius source code for details. This behavior is on by default but can be disabled in babysit.yaml with `config.isolate_dependencies: false`
- Babysit installation by default is done by installing the `babysit` binary to the location the OS we are on expects it. The installation script (similar to `sir-claudius` install.sh) should offer an easy cross platform installation experience including verifying that dependencies are installed and offering to install them if they are not
- `babysit` passes host credentials for the coding agents to the container in a platform specific manner, this may mean periodically refreshing the token on the host. See `sir-claudius` source code for reference but note that the implementation should be different and improved for `babysit`
- `babysit` updates itself in a github action just like `sir-claudius`
- any flags passed to `babysit` that it does not recognize are passed as arguments to the coding agent cli
- for coding CLIs that have effort and model settings, `babysit` auto-selects the latest model and a high-effort default
- the statusline is similar to sir-claudius but without the usage logic

## Implementation details

`babysit` is implemented as a js project that is built into an executable using bun. Make sure there is a github action that builds the project when there is a version change in the package.json field.
