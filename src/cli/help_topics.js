import { is_agent } from '../agents/index.js'
import { effort_help, exit_help, loop_help, model_help, reset_help, stuck_help } from '../docker/assets/effort/command.mjs'
import { usage_help } from '../docker/assets/usage/command.mjs'
import { FLAGS, LAUNCH_FLAG_ROWS, dashed, format_rows, options_table } from './registry.js'

/*
 * Per-command help: `babysit <command> [sub] --help` or `babysit help <command> [sub]`.
 * Each topic is plain text: usage, how it works, options, examples. The
 * in-session commands (effort, model, exit, stuck, loop, reset, usage) keep their
 * text in the container assets so the image's helper prints the same thing.
 */

// Launch flags of babysit <agent>, from the registry
const AGENT_FLAGS = `Options:
${ format_rows( LAUNCH_FLAG_ROWS, { width: 26 } ) }

Unknown flags pass through to the agent CLI (e.g. --model, --effort).`

const TOPICS = {

    agent: agent => `Usage: babysit ${ agent } [options] [agent CLI flags]

Starts ${ agent } in a Docker container inside tmux and attaches to it. A detached
monitor applies babysit.yaml rules, syncs credentials both ways, and keeps the
session recoverable. Detach with Ctrl+B d; reattach with babysit open.

Before launch, Babysit verifies ${ agent }'s login (cached 12h; see babysit auth --help).

${ AGENT_FLAGS }

Examples:
  babysit ${ agent } --yolo
  babysit ${ agent } --clone --name "feature 1"
  babysit ${ agent } --sandbox --loop
  babysit ${ agent } --mudbox --port 3000
  babysit ${ agent } resume 1             Resume a row from babysit resume (see babysit ${ agent } resume --help)
  babysit claude --yolo --model sonnet --effort high`,

    'agent resume': agent => `Usage: babysit ${ agent } resume <id|number> [options] [agent CLI flags]

Same as babysit resume <id|number>, but the selected history row must belong to
${ agent }. The saved conversation, modes, and ports come back on the current
image; credentials are reloaded from the host. Flags given here override the saved ones.

Examples:
  babysit ${ agent } resume 1
  babysit ${ agent } resume 1 --all       Number from babysit resume --all
  babysit ${ agent } resume abc-123 --yolo`,

    resume: () => `Usage: babysit resume [--all] [-n N]
       babysit resume <id|number> [options] [agent CLI flags]

Without a selector: list this workspace's saved sessions, newest 10 rows.
With one: restore that session (conversation, modes, ports) on the current image and attach.
Numbers follow the current listing; IDs are durable.

${ options_table( `resume` ) }
  (launch flags such as --yolo or --loop override the saved ones)

Examples:
  babysit resume
  babysit resume -n 30
  babysit resume --all
  babysit resume 1
  babysit resume 1 --all
  babysit resume abc-123 --yolo`,

    fork: () => `Usage: babysit fork <number|session_id> [agent] [options] [-- agent CLI flags]

Starts a new session that continues another one, live or exited. The number is
a babysit list row (exited parents of live forks keep theirs). The fork inherits
the parent's flags, config, and (same agent only) model/effort; flags typed here win.

Filesystem (asked when interactive; the default is in capitals):
  share   Work in the parent's workspace (or its clone). Default for an exited or stuck parent.
  clone   Full snapshot of the parent's tree on a new branch: uncommitted, untracked
          and unpushed work included. Default for a live parent. Never push to its branch.
  A --mudbox fork shares read-only and a --sandbox fork has no files; neither asks.

History:
  Same agent: the agent's own fork (claude --fork-session, codex fork, opencode --fork).
  Other agent or a sandbox parent: babysit writes a handoff summary of
  the parent transcript to /tmp/babysit-fork-handoff.md and asks the fork to read it.

${ options_table( `fork` ) }
  (plus the launch flags of babysit <agent>: --yolo, --docker, --adb, --name, --config, --port, --loop, --log)

Examples:
  babysit fork 2
  babysit fork 2 codex                 Hand a Claude session over to Codex
  babysit fork 2 --clone --takeover
  babysit fork 1 --share --mudbox      Read-only second opinion in the same tree
  babysit fork abc-123 --no-history --name "fresh eyes"`,

    init: () => `Usage: babysit init [file.yaml]

Writes a default config. Without a file name it asks for one (default
babysit.yaml), then opens the launch menu: its choice becomes the live launch:
section (agent, name, mode, yolo, docker, adb, clone, loop,
ignore_host_agents_md, ports, log, args). Keys at their default are written commented; everything else is commented out.

launch: drives \`babysit --config DIR/\`, which starts one detached session per
DIR/*.yaml (only agent required, other keys default; name defaults to the file name),
shows an overview, asks y/N (--yes skips), and skips files whose session is
still running. \`babysit --config FILE\` opens the menu with its values.

Rules run top-down; the first match wins:
  on:      idle | literal text | /regex/flags (matched against the last 10 pane lines)
  do:      enter | a config.commands name | text | ./FILE.md (=== separates steps)
  timeout: idle rules only, SS | MM:SS | HH:MM:SS

Use a non-default name with --config FILE on launch.

Examples:
  babysit init
  babysit init review.yaml
  babysit codex --config review.yaml
  babysit --config sessions/`,

    audit: () => `Usage: babysit audit --config FILE|DIR/ [--yes]

Checks yaml files against what \`babysit --config DIR/\` requires (every launch:
key but name, valid values) and fixes them in place, keeping comments and order.
DIR/ means every DIR/*.yaml|yml, the same set a directory launch reads.

Per file: lists problems and asks about the agent when missing (never assumed)
and about unset keys that change behaviour (mode, yolo, docker, adb, clone,
loop, ignore_host_agents_md). Non-default answers are written live, defaults as
commented lines that are not asked about again. ports, log and args are never
added. Offers y/N per
invalid value (reset to default) and unknown key (remove). Optional keys (name,
config:, babysit:) are never offered. Shows a diff, then Write? [Y/n].

Without a terminal it only reports. Exit 1 while any file still fails.

${ options_table( `audit` ) }

Examples:
  babysit audit --config review.yaml
  babysit audit --config sessions/
  babysit audit --config sessions/ --yes`,

    clean: () => `Usage: babysit clean --config FILE|DIR/ [--dry-run]

Strips full-line comments and blank lines from configuration yaml in place, for
a config you are done editing. Inline comments (key: value # note) stay. DIR/
means every DIR/*.yaml|yml, the same set a directory launch reads.

Text inside multi-line values (| and > blocks, quoted strings) is never touched,
and a file is only rewritten if it still parses to the same values. Invalid
yaml is reported and left alone; exit 1 if any file could not be cleaned.
Not undoable outside version control: try --dry-run first.

${ options_table( `clean` ) }

Examples:
  babysit clean --config babysit/config.yaml
  babysit clean --config sessions/ --dry-run`,

    list: () => `Usage: babysit list [--all]

Active sessions as a tree: workspace trunks with numbered leaves, colored status
(idle grey, running green, waiting orange, stuck red), container CPU/MEM, and a
totals row. Numbers are what open, close, archive, and restart accept.

${ options_table( `list` ) }

For a live view with account usage, run babysit watch --all.

Examples:
  babysit list
  babysit list --all`,

    watch: () => `Usage: babysit watch [--usage | --all] [--interactive]

Live dashboard: the babysit list tree without archived sessions with a USAGE
column. Sessions are ordered by when you last opened them (never by activity;
never-opened ones sink), so numbers move when that changes. Sessions idle over
24h move to a condensed "Idle resumable sessions" list below the tree
(folder/repo - name - Nd Nh since last opened); unread ones keep their dot.
Panes are sampled every second and the list redraws the moment a session
starts, closes or is archived; only changed frames are drawn. Usage refreshes every 5 min. Idle sessions with an idle
rule (on: idle, --loop) show hh:mm to their next turn as status; config: and
on: flags show only with --all.

In a terminal the dashboard is always navigable, like the list you land on after
detaching (--interactive forces the keys when stdin is not a terminal); ctrl+c
closes. Detaching (ctrl+b d) or the
session closing comes back to this list; after babysit open, start or fork in
a terminal that happens on its own. Keys (? shows them in the dashboard):
  up/down    select a session (the cursor follows it when the order changes)
  enter      open the selected session
  0-9        type a session number to open it (a short pause settles multi-digit numbers)
  space      mark an unread session read
  e          move to the idle list until its next finished turn
  f          freeze / unfreeze (Docker sessions)
  r          restart; rr when the session is not idle (then forced)
  i          show / hide each session's task title (the agent's terminal title)

USAGE column: the usage bar for the worst rate window of the session agent's
account, filled by the share used (extra usage, spend caps and balances do not
count); — while unknown.

Usage panel (--usage, --all): account usage per agent, one row per metered
limit with a bar, % used and time to reset. Balances and lifetime spend stay in
babysit usage. With two or more Claude accounts, each gets its own rows
(claude / <account>).

${ options_table( `watch` ) }

Examples:
  babysit watch
  babysit watch --interactive
  babysit watch --usage
  babysit watch --all`,

    open: () => `Usage: babysit open [id|name|number]

Attaches to an active session. Without a selector it attaches to this
directory's only session, or lists them when there are several. Opening an
archived session un-archives it. After you detach, your shell moves to the
directory the agent works in (its clone, for --clone sessions) when the
babysit shell-init function is installed; otherwise the cd line is printed.

Examples:
  babysit open
  babysit open 2                 Row 2 of babysit list
  babysit open "feature 1"`,

    'shell-init': () => `Usage: babysit shell-init [bash|zsh|fish]

Prints a babysit shell function so babysit open can move your shell into the
session's workspace (a program cannot change its parent shell's directory),
the short name sit for babysit, and tab completion for commands, agents, flags
and subcommands. Defaults to $SHELL.

Examples:
  babysit shell-init fish
  echo 'eval "$(babysit shell-init)"' >> ~/.bashrc     # or ~/.zshrc
  echo 'babysit shell-init fish | source' >> ~/.config/fish/config.fish`,

    close: () => `Usage: babysit close <number|session_id>...

Closes sessions on purpose: the agent stops, the container is removed, and
recovery will not bring this launch back. Resume it later with babysit resume.
Numbers mean the list as it was before the first close; one failure does not
stop the rest.

Examples:
  babysit close 2
  babysit close 3 4 5
  babysit close abc-123`,

    restart: () => `Usage: babysit restart <number|session_id|all>... [--force] [--detach] [--continue] [--account NAME]

Closes the session gracefully and resumes it on the current image, continuing
the agent's own conversation id. Use it after babysit update. Refuses unless
the agent is idle or waiting and its native session id was captured.
Sandbox sessions cannot be restarted. Several selectors or "all" restart
detached, skipping (and reporting) any that refuse; numbers mean the list as
it was before the first restart. Claude sessions move to the subscription with
most headroom. Without --continue, a terminal asks once whether to send one.

A single restart in a terminal first opens the launch menu, prefilled with the
session's switches: add or drop Docker, devices, YOLO, loop, mode, name, ports
or agent arguments, then Enter. Agent and clone workspace are fixed, and
Sandbox is refused since it would lose the conversation. Batches,
babysit watch and scripts keep each session's switches.

${ options_table( `restart` ) }

Examples:
  babysit restart 1
  babysit restart 1 6 3
  babysit restart 1 --detach
  babysit restart all
  babysit restart abc-123 --force
  babysit restart 2 --account work --continue
  babysit restart all --account failover`,

    archive: () => `Usage: babysit archive [<number|session_id|name>...] [--yes]

Dims sessions and sinks them to the bottom of their workspace in babysit list.
They keep running, and babysit prune keeps their clones. babysit open
un-archives one. Numbers mean the list as it was before the first archive.

Without selectors it lists the grey-dot sessions (idle over 24 hours, nothing
unread) and asks Archive N sessions? [Y/n]. --yes skips the question; scripts
without a terminal must pass it.

Examples:
  babysit archive
  babysit archive 3
  babysit archive 2 5 6
  babysit archive "feature 1"`,

    freeze: () => `Usage: babysit freeze <number|session_id|name|all>...

Pauses session containers in place with docker pause: every process stops
mid-step and nothing is killed. babysit unfreeze resumes them where they left
off. Host only (see babysit mode), Docker sessions only. The monitor stands
down while frozen (no idle nudges, watchdog or auto-approvals) and restarts its
timers on unfreeze. babysit list shows frozen; the tmux bar says FROZEN.

Caveats: keys typed into a frozen pane arrive on unfreeze. Agents retry API
calls that timed out while frozen; a tool command's own timeout can fire on
resume. Freezing ends at reboot or a Docker restart. close works on frozen
sessions.

Examples:
  babysit freeze 2
  babysit freeze all
  babysit unfreeze all`,

    unfreeze: () => `Usage: babysit unfreeze <number|session_id|name|all>...

Resumes sessions paused by babysit freeze; all means every frozen session.
See babysit help freeze.

Examples:
  babysit unfreeze 2
  babysit unfreeze all`,

    prune: () => `Usage: babysit prune [--list]

Interactive cleanup. First shows what is reclaimable and where (Docker build
cache, images, stopped containers, clones per age policy) with estimates and
free disk space; after deleting, reports the space actually freed.
Docker: Babysit's own stopped containers and images no saved session needs
(the current image, in-use images, and everything from other projects stay),
and build cache unused for 7 days (BuildKit's cache is shared by all projects).
Networks and volumes are never touched. Clones: managed clone workspaces by age. Each part asks for
its own confirmation.

${ options_table( `prune` ) }

Examples:
  babysit prune
  babysit prune --list`,

    recover: () => `Usage: babysit recover [id|number] [--dry-run] [--json] [--no-continue]
       babysit recover init

Restarts sessions that were interrupted (reboot, Docker restart, crash), detached,
across workspaces. Each resumes its saved conversation and is told: "You were
interrupted. Check the current state, then continue unfinished work." Live
agents are left alone; closed sessions are never recovered.

${ options_table( `recover` ) }

Examples:
  babysit recover --dry-run
  babysit recover
  babysit recover 2 --no-continue
  babysit recover init           Recover automatically at boot (see babysit recover init --help)`,

    'recover init': () => `Usage: babysit recover init

Installs a systemd system service (Ubuntu) that runs babysit recover at boot
for your account, so sessions come back without logging in. Needs system
Docker, direct Docker access, and home/workspaces available before login.
Run it as yourself; it asks for sudo itself (a sudo prefix can strip PATH).
Rerun after moving the executable or BABYSIT_HOME.

Examples:
  babysit recover init
  journalctl -u "babysit-recover-$(id -u).service"
  sudo systemctl disable "babysit-recover-$(id -u).service"   Turn it off`,

    config: () => `Usage: babysit config
       babysit config --transcripts PATH|off|default

Overview (read-only without flags): storage paths, Docker image and socket,
launch-menu defaults, auth checker, web bridge, boot recovery, transcript archive.

Transcript archive (on by default, ~/.babysit/transcripts, under BABYSIT_HOME):
every session's native agent transcripts are mirrored there every 10 minutes
and when it ends. That is every message, tool call, tool result and per-turn
token usage, subagents included (Claude subagents/*.jsonl, Codex subagent
rollouts). Files stay in each agent's own format (JSONL, SQLite); credential
files are skipped. Tool output can still contain secrets: the archive is 0700.
  volumes/<volume>/         Claude, Codex, OpenCode state volumes
  sandbox/<babysit_id>/     sandbox sessions, copied before the container goes
  sessions/<babysit_id>.json  agent, workspace, Claude account, native session id
PATH is a host directory (~ expands, relative resolves here); off disables;
default restores ~/.babysit/transcripts. Saved in ~/.babysit/config.json
(transcript_archive) and read when each session's monitor starts.

Examples:
  babysit config
  babysit config --transcripts ~/archive/agents
  babysit config --transcripts off`,

    mode: () => `Usage: babysit mode

Prints \`container\` inside a babysit agent container, \`host\` anywhere else
(including unrelated Docker containers). Lets scripts branch on where they run.

Example:
  babysit mode
  [ "$(babysit mode)" = container ] && echo "inside babysit"`,

    doctor: () => `Usage: babysit doctor --auth [agent|all] [--refresh]

Real model-backed login check for every installed agent (or one): each runs a
tiny prompt in a throwaway container with the credentials sessions get.
Successes are cached 12h, which also lets launches skip their own check.

${ options_table( `doctor` ) }

Examples:
  babysit doctor --auth
  babysit doctor --auth claude
  babysit doctor --auth opencode --refresh`,

    auth: () => `Usage: babysit auth [status]
       babysit auth check [agent] [--force]
       babysit auth init [--remove] [--no-linger] [--claude-token | --no-claude-token]
       babysit auth init --claude-token [--token-stdin] [--name NAME]
       babysit auth accounts [remove NAME]

Keeps agent logins verified so launches start fast, and tells you when one
breaks. Launches make no model call (a local check only stops a launch with
no login at all); babysit doctor --auth verifies a login and caches it for
12h. The checker (installed by babysit auth init) runs babysit auth check every
10 minutes to keep those entries warm and catch logouts:
  offline        every run: credential file deleted, Claude refresh token expired
  host CLI       after 1h: one ~3s prompt through your own claude/codex
  container      after 6h: re-verifies and refreshes the launch cache
  session pane   a session showing the agent's logged-out message triggers a check
With PUSHOVER_TOKEN and PUSHOVER_USER (e.g. in ~/.babysitrc) it pushes logout
alerts and usage alerts at 90%.

Subcommands:
  status    Cache ages and checker state (default)
  check     What the checker runs (babysit auth check --help)
  init      Install the checker and the Claude token (babysit auth init --help)
  accounts  Named Claude subscriptions (babysit auth accounts --help)

Examples:
  babysit auth
  babysit auth init
  babysit auth check claude --force
  babysit auth accounts`,

    'auth accounts': () => `Usage: babysit auth accounts [remove NAME]

Several Claude subscriptions, one setup-token each. The ~/.babysitrc token is
the account "default"; add more with babysit auth init --claude-token --name NAME
(stored 0600 in the Babysit state dir). With two or more, a new Claude session
takes the account with most headroom (the tightest rate window, read with one
1-token request per account, cached 5 min); --account NAME forces one. The
session keeps its account through resume, restart, and recovery. When a session
hits its limit, the monitor moves it to another account with headroom, never
back to one it left while that limit window is open
(config.claude_account_auto_switch, default true).
Codex and OpenCode sessions get an account too (from cached readings, never a
probe), so a nested claude call runs on a setup-token.
Sessions switch in place: Claude re-reads its
credentials file before every request, so Babysit rewrites the token there,
presses Esc and types a continue prompt (or, while you are attached, leaves the
typing to you). No restart, same process and conversation; the prompt cache is
per account, so the first request after a switch re-reads the context. No
session uses the host /login file. Sessions from before 2.0 with one account
switch by restart (resume plus a continue prompt) and only while detached.
The token reaches the container as a private file copied in with docker cp,
never a docker -e flag.

Shows name, mint date, expiry, and the last headroom read. Tokens are never printed.

Examples:
  babysit auth accounts
  babysit auth init --claude-token --name work
  babysit auth accounts remove work
  babysit claude --account work`,

    'auth status': () => `Usage: babysit auth status

Shows each agent's cached login: when it was verified, how old that is, and
whether the scheduled checker is installed. Missing entries mean the next
check (babysit auth check or doctor --auth) probes first.

Examples:
  babysit auth
  babysit auth status`,

    'auth check': () => `Usage: babysit auth check [agent] [--force]

What the scheduled checker runs. Agents with credentials on the host (Claude:
a setup-token or route; OpenCode stays with doctor --auth) are checked,
cheapest first: offline file checks, then a host CLI prompt once the last proof
is 1h old, then a container re-verify after 6h. A host probe waits while a
session might be refreshing the same token. Network failures never alert.
Skips when a launch or another check holds the authentication lease.

${ options_table( `auth`, `check` ) }

Examples:
  babysit auth check
  babysit auth check codex
  babysit auth check claude --force`,

    'auth init': () => `Usage: babysit auth init [--remove] [--no-linger] [--claude-token | --no-claude-token]
       babysit auth init --claude-token [--token-stdin] [--name NAME]

1. Installs the 10-minute checker for your user: a systemd user timer on Linux
   (and enables lingering so it runs while you are logged out), a launchd agent
   on macOS. PUSHOVER_* set now are written into the schedule.
2. Offers a one-year Claude token when CLAUDE_CODE_OAUTH_TOKEN is unset: runs
   claude setup-token (approve in the browser), then asks you to paste the
   printed token, proves it with one prompt, and saves it to ~/.babysitrc
   (0600). Without a host claude, --claude-token takes a token minted on any
   other machine (claude setup-token) and only checks its format.
Containers run Claude only on this token (the rotating /login is never staged),
so a Claude launch without one fails unless an API key, Bedrock, Vertex or
Foundry route is configured. Restart running Claude sessions to switch.
Rerun after upgrading Babysit to pick up schedule changes.
With --name NAME or --token-stdin only step 2 runs. --name makes the token a
named Claude account (see babysit auth accounts --help) instead of replacing
~/.babysitrc; --token-stdin reads it from a pipe, no terminal needed.

${ options_table( `auth`, `init` ) }

Examples:
  babysit auth init
  babysit auth init --claude-token
  babysit auth init --no-claude-token --no-linger
  babysit auth init --remove
  babysit auth init --claude-token --name work
  echo "$TOKEN" | babysit auth init --claude-token --token-stdin`,

    mac: () => `Usage: babysit mac add NAME HOST [--user U] [--password-env VAR | --password-stdin]
       babysit mac list | check [NAME] | enable NAME | disable NAME | forget NAME

Remote Macs for --mac (or --devices) sessions, driven over SSH and Screen Sharing.
Passwords and ssh keys stay in ~/.babysit/macs (0700) and are uploaded only into
sessions that ask for --mac (enabled Macs only; into a memory-only tmpfs); they
never enter Docker metadata, config or logs. The password comes from a pipe or an
environment variable, never an argument.

On the Mac, once: Remote Login and Screen Sharing on (System Settings > General >
Sharing), a dedicated standard or admin account, sleep and lock off.

Examples:
  babysit mac add office 192.168.1.50 --user mentor --password-stdin
  babysit mac check office      # installs the ssh key, tests ssh and Screen Sharing
  babysit mac list
  babysit mac disable office    # stays registered; sessions stop receiving its secrets
  babysit mac forget office`,

    windows: () => `Usage: babysit windows add NAME HOST [--user U] [--password-env VAR | --password-stdin]
       babysit windows list | check [NAME] | enable NAME | disable NAME | forget NAME

Windows PCs for --windows (or --devices) sessions, driven over SSH and VNC.
Secrets are handled like Macs': ~/.babysit/windows (0700), uploaded only into
--windows sessions (enabled PCs only; memory-only tmpfs), password from a pipe
or an environment variable. --user is the local account name (C:\\Users\\<name>);
for a Microsoft account the password is the account password, not the PIN.

On the PC, once (PowerShell as Administrator):
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Set-Service sshd -StartupType Automatic; Start-Service sshd
  Set-NetConnectionProfile -NetworkCategory Private     # LAN = trusted network
  New-NetFirewallRule -Name babysit-vnc -DisplayName 'VNC (babysit)' -Protocol TCP -LocalPort 5900 -Action Allow -Profile Private
Then install TightVNC Server (service mode) and set its primary password to the
first 8 characters of the account password (VNC only uses 8). Sleep off; keep
it on mains power. For unlock: sign in with the password, not a PIN or Windows
Hello (Settings > Accounts > Sign-in options; Microsoft accounts: turn off
"only allow Windows Hello sign-in").

Examples:
  babysit windows add laptop 192.168.2.85 --user mentor --password-stdin
  babysit windows check laptop  # installs the ssh key, tests ssh and VNC
  babysit windows list
  babysit windows disable laptop
  babysit windows forget laptop`,

    web: () => `Usage: babysit web init | babysit web key add|list|remove [NAME]

Babysit Web is a mobile companion for your sessions (see babysit web init --help).
Read-only API keys open its JSON API to scripts (see babysit web key --help).

Examples:
  babysit web init
  babysit web key add grafana`,

    'web key': () => `Usage: babysit web key add|list|remove [NAME]

Read-only API keys for the Babysit Web JSON API. Keys can read every GET
endpoint (/api/status, /api/sessions, /api/sessions/:id) but never send
messages. Only a hash is stored; the key is shown once. Changes apply at once,
no restart. babysit web init (token rotation) keeps API keys.

Use: curl -H "Authorization: Bearer <key>" https://<origin>/api/status
Full reference: API docs in the web app menu.

Examples:
  babysit web key add grafana
  babysit web key list
  babysit web key remove grafana`,

    'web init': () => `Usage: babysit web init

Creates the bridge directory the web companion reads and prints its access
token. Rerun to rotate the token, which also logs out every browser.
Running sessions discover the bridge; start the companion with Docker Compose
(see examples/compose.web*.yml).

Examples:
  babysit web init
  BABYSIT_WEB_UID="$(id -u)" BABYSIT_WEB_GID="$(id -g)" docker compose -f examples/compose.web.local.yml up --build -d`,

    update: () => `Usage: babysit update [--auto]

Updates Babysit itself, the ~/.agents repository, the Docker image (120s pull
limit), and the host agent CLIs, then shows the image version. Running sessions
keep their image; babysit restart moves one over. A running babysit web container
is pulled too and, on a new image, recreated through its Compose project.

--auto asks "Enable automatic updates? Y/n". When on, any babysit command that
knows of a newer release (checked at most every 6 hours) runs babysit update in
the background once, logging to ~/.babysit/auto-update.log; a failed attempt
retries a day later. Off by default.

Examples:
  babysit update
  babysit update --auto`,

    usage: () => usage_help,
    effort: () => effort_help,
    model: () => model_help,
    exit: () => exit_help,
    stuck: () => stuck_help,
    loop: () => loop_help,
    reset: () => reset_help,

}

// Flags whose next argument is a value, not a command word (registry, every scope)
const VALUE_FLAGS = new Set( FLAGS.filter( flag => flag.type !== `boolean` ).map( flag => dashed( flag.name ) ) )

// After `--` everything is literal agent input, `-h` included
const babysit_args = argv => argv.includes( `--` ) ? argv.slice( 0, argv.indexOf( `--` ) ) : argv

/**
 * Pick the help topic for an argv: `auth init --help`, `help auth init`,
 * `claude resume 2 --help`. Unknown commands fall back to the overview.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {string|null} Rendered topic, or null for the overview
 */
export const help_topic = argv => {

    const own = babysit_args( argv )
    const words = own.filter( ( arg, index ) => !arg.startsWith( `-` ) && !VALUE_FLAGS.has( own[ index - 1 ] ) )
    if( words[0] === `help` ) words.shift()
    if( !words.length ) return null

    const [ first, second ] = words
    if( is_agent( first ) ) return TOPICS[ second === `resume` ? `agent resume` : `agent` ]( first )

    const key = [ `${ first } ${ second }`, first ].find( candidate => Object.hasOwn( TOPICS, candidate ) )
    return key ? TOPICS[ key ]() : null

}

/**
 * Whether argv asks for help: any --help/-h, or a leading `help` word.
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {boolean}
 */
export const wants_help = argv => argv[0] === `help` || babysit_args( argv ).some( arg => arg === `--help` || arg === `-h` )

export const HELP_TOPIC_NAMES = Object.keys( TOPICS )
