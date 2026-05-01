This cli is called `babysit`. It is designed as a supervisor for LLM coding agent clis like `claude`, `codex`, `gemini`, and `opencode`. It is the spiritual successor of [sir-claudius](https://github.com/actuallymentor/sir-claudius). You should clone and read the claudius source code to learn from the lessons of that project timeline. You do NOT have to implement all sir-claudius features.

In order to implement the coding agents properly, you will need to browse the web for their documentation.

The core functionality is that when run, `babysit` will:

- Run subcommands in a tmux session, so that the user can detach and re-attach to the session as needed
- The babysit tmux sessions have their own -L, have history set to 10000, have `set -g mouse on`, and are named `babysit_$(pwd)_<agent_name>_<timestamp>` for easy identification
- Start a `babysit` docker container that will contain the LLM coding agent cli
- The container mounts the current PWD in /workspace, so the LLM coding agent cli can read/write files in the current directory
- Mounts the host ~/.agents to the container ~/.agents in read only
- The container installs the dependencies that sir-claudius has in the image as well (look at that dockerfile), you may also add common clis that coding agents like using like fzf
- Start the coding agent in the container
- Importantly, the container has passwordlless sudo, and has all coding clis preinstalled, with the host credentials for these agents passed through in a platform-specific manner (we support OSX and Ubuntu Linux)
- Run mode is passed to the container through the environment variable AGENT_AUTONOMY_MODE, which can be `sandbox`, `mudbox`, `yolo`, or empty for default. The system prompt of the coding agent is configured based on this mode to give the agent appropriate instructions and limitations.
- The `babysit` cli monitors the content of the sessions and provides input based on `babysit.yaml`, a file the cli creates on first run in the current directory. The instructions there are "first one wins" when there are conflicts.
- The `babysit.yaml` file has `config` and `babysit` sections. The `config` section contains configutations about behavior. The `babysit` section contains the actions that `babysit` takes depending on the output (or idle) of the tmux session with the coding agent. The `babysit:` section contains `on/do` pairs where `on` can be a keyword, a literal string, or a regex. The `do` can be a command defined in the `config:` section, a literal string, or a markdown file. In both string and markdown cases, sections may be defined using `===` segments, which instructs `babysit` to wait for idle after executing each segment. This allows the user to create complex instructions that are executed step by step when the agent is idle in between.
- The `on:` keyword options are: idle, plan, choice, literal string, and regex. Idle means "no new output in the tmux session for longer than the timeout". Plan means the agent is asking the user to accept a plan, this is detected through a matching table (like a patterns.js kind of file with agent>regex pairings) that `babysit` keeps per coding agent. Choice means the agent is waiting for user input other than accepting a plan, this is also detected through a matching table. Literal string matching works on the latest output going back N lines (this is a config variable set to 10 by default). Regex matching also works on the latest output with a separate lines config.

Default `babysit.yaml` instructions created when there is no `babysit.yaml` in the current directory:

```yaml
# babysit.yaml

# Babysit configuragion
config:
    idle_timeout_s: 300 # The amount of seconds of inactivity (no output in the tmux session) that count as `on: idle`
    commands:
        notify_command: >
            curl -f -X POST -d \
                "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input&url=&priority=0" https://api.pushover.net/1/messages.json

# Babysit instructions
babysit:

    # Format:
    # - on: <event> # unquoted words are special keywords, quotes words are literal matches, regex is supported with /regex/flags. Note that the `on:` only triggers if the match is the latest seen output for longer than the timeout
    #   do: <action> # unquoted words are special keywords or commands specified in config.commands, quoted words are literal input followed by and enter keystroke

    # This instructs babysit to type and submit "check for bugs" into the tmux session when the coding agent is idle for the timout period (including sub agents)
    - on: idle # this means no new output in the thux session
      do: ./IDLE.md # this may point to any markdown file on the host, either as a relative or absolute path
      timeout: 30:00 # overrides idle_timeout_s, format can be: SS, MM:SS, or HH:MM:SS
    
    # This instructs babysit to accept any plan that the coding agent submits by pressing "enter" when it encounters a plan acceptance step
    # - on: plan # this means the coding agent is asking the user to accept a plan
    #   do: enter
    #   timeout: 10 # waits 10 seconds
    
    # Instructs babysit to run the notify_command when the coding agent is waiting for user input, so that the user gets a push notification on their phone to check the session
    - on: choice # this is a generic option for any scenario the coding agent is waiting for user input
      do: notify_command
      timeout: 1:00:00 # Waits 1 hour

    - on: /error/i # regex match on the tmux session output, case insensitive
      do: notify_command
      timeout: 05:00

```

## Coding agent configuration

The coding agent is provided this system prompt:

```
You are running inside a Docker container — an isolated sandbox built for coding agents. You have passwordless sudo for any operation that needs root, this is safe for you to use at will. Your workspace is /workspace (bind-mounted from the host).

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

In yolo mode this is APPENDED:

```
You are running in YOLO mode (AGENT_AUTONOMY_MODE=yolo). The environment variable AGENT_AUTONOMY_MODE is set to 'yolo'. In this mode you are expected to act with maximum autonomy — fulfill the user's intent with as little interaction as possible. Do not ask for confirmation before taking actions. Prefer doing over asking. If a task is ambiguous, make a reasonable choice and proceed. Commit your work without confirmation.
```

## Feature flags:

`--yolo` add --dangerously-skip-permissions or equivalent flag to the coding cli, also inject AGENT_AUTONOMY_MODE='yolo' into the container env. Also passes adds the following to the system prompt of the agent: `
`--sandbox` do not mount any host directory into the container, the fs inside the container is ephermal
`--mudbox` mount the current pwd as read only, so the coding agent can read files but not write them
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
`babysit gemini --mudbox --yolo` - starts a gemini session in mudbox mode, so the current directory is mounted read-only and the agent can explore files but not modify them. Also sets AGENT_AUTONOMY_MODE to yolo, sets system prompt accordingly, and sets dangerourly skip permissions or equivalent for maximum agent autonomy.
`babysit opencode resume xxxx-xxxx-xxxx-xxxx --yolo` - resumes a opencode session with the given id, in yolo mode (AGENT_AUTONOMY_MODE=yolo, system prompt configured accordingly, and maximum agent autonomy permissions enabled).

## Feature list in no particular order

- git user information is passed from the host to the container, defaults are set like in the sir-claudius Dockerfile, but the author is "Babysitter" for both author and committer name by default, also swap the repos of course
- when a babysit session is exited, the babysit manager prints "To resume this session, run `babysit resume <session_id>`", this will require `babysit` to get the session id after starting, as it cannot easily grab it after the session was closed
- `babysit list` command to list active sessions with their session ids and the coding agent running in them
- `babysit open <session_id>` command to open a tmux session attached to the given session id, note that `babysit resume` is used to resume exited sessions and uses the session id as the coding agent knows it, but `babysit open` is used to connect to active tmux sessions. 
- On any babysit command, the cli: checks if all dependencies are installed, runs git pull on the babysit repo if it exists, runs git pull on ~/.agents if it exists, pulls the latest docker image for the coding agent
- For common dependency folders like `node_modules` or `.venv`, babysit does not mount the host folder but mounts a docker volume specific to this folder, which has caching. See the sir-claudius source code for details. This behavior is on by default but can be disabled in babysit.yaml with `config.isolate_dependencies: false`
- Babysit installation by default is done by installing the `babysit` binary to the location the OS we are on expects it. The installation script (similar to `sir-claudius` install.sh) should offer an easy cross platform installation experience including verifying that dependencies are installed and offering to install them if they are not
- `babysit` passes host credentials for the coding agents to the container in a platform specific manner, this may mean periodically refreshing the token on the host. See `sir-claudius` source code for reference but note that the implementation should be different and improved for `babysit`
- `babysit` updates itself in a github action just like `sir-claudius`
- any flags passed to `babysit` that it does not recognize are passed as arguments to the coding agent cli
- for coding CLIs that have effort and model settings, `babysit` always auto-selects the maximum effort and latest model
- the statusline is similar to sir-claudius but without the usage logic

## Implementation details

`babysit` is implemented as a js project that is built into an executable using bun. Make sure there is a github action that builds the project when there is a version change in the package.json field.
