import { SUPPORTED_AGENTS, is_agent } from '../agents/index.js'
import { effort_help, exit_help, loop_help, model_help, stuck_help } from '../docker/assets/effort/command.mjs'
import { usage_help } from '../docker/assets/usage/command.mjs'

/*
 * Per-command help: `babysit <command> [sub] --help` or `babysit help <command> [sub]`.
 * Each topic is plain text: usage, how it works, options, examples. The
 * in-session commands (effort, model, exit, stuck, loop, usage) keep their
 * text in the container assets so the image's helper prints the same thing.
 */

const AGENT_FLAGS = `Options:
  --yolo                    Maximum autonomy: skip agent permission prompts, AGENT_AUTONOMY_MODE=yolo
  --sandbox                 No workspace mount; the container and its files are thrown away
  --mudbox                  Read-only workspace mount
  --clone                   Work in a durable copy; the original is mounted read-only at /original
  --yes                     Accept clone safety prompts (e.g. chmod of unreadable paths)
  --docker                  Mount the host Docker socket (controls the host daemon, even in sandbox)
  --adb                     Android adb with a key shared by every session (network devices only)
  --ios                     iOS 16 devices via WebDriverAgent, pairing shared by every session (network only)
  --devices                 Every device kind: --adb and --ios
  --ignore-host-agents-md   Leave out host instructions, skills, preferences, and ~/.babysitrc setup; keep credentials
  --name NAME               Human-readable session name (shown in babysit list, usable with open)
  --config FILE             Use FILE instead of ./babysit.yaml; kept on resume and in clones
  --port PORT | H:C         Publish a port; repeatable
  --loop                    When idle, type ./LOOP.md, ~/.agents/LOOP.md, or "Keep going"
  --log[=PATH]              Append raw tmux output to PATH (default .YYYY_MM_DD_HH_MM.babysit.log)
  --account NAME            Claude: run on this subscription (babysit auth accounts); default picks most headroom

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

Options:
  --all       Every workspace and every row (numbers then refer to this listing)
  -n N        Show N rows instead of 10
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
  Other agent, Antigravity, or a sandbox parent: babysit writes a handoff summary of
  the parent transcript to /tmp/babysit-fork-handoff.md and asks the fork to read it.

Options:
  --share | --clone         Pick the filesystem without asking
  --yes                     Take the defaults (as does --yolo); required on non-interactive stdin without --share/--clone
  --no-history              Start a fresh conversation
  --takeover                Close the live parent once the fork runs (otherwise: Close #N? [y/N])
  --regular | --sandbox | --mudbox    Switch mode
  --no-yolo, --no-docker, --no-adb, --no-loop    Drop a flag the parent had
  --account NAME            Claude subscription; a Claude → Claude fork otherwise keeps the parent's
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

Options:
  --yes      Apply every fix without asking, add nothing.
             A missing agent still needs a terminal.

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

Options:
  --dry-run  Report what would be removed without writing

Examples:
  babysit clean --config babysit/config.yaml
  babysit clean --config sessions/ --dry-run`,

    list: () => `Usage: babysit list [--all]

Active sessions as a tree: workspace trunks with numbered leaves, colored status
(idle grey, running green, waiting orange, stuck red), container CPU/MEM, and a
totals row. Numbers are what open, close, archive, and restart accept.

Options:
  --all      Add tmux attachment, session IDs, and tmux names

For a live view with account usage, run babysit watch --all.

Examples:
  babysit list
  babysit list --all`,

    watch: () => `Usage: babysit watch [--usage | --all] [--interactive]

Live dashboard: the babysit list tree without archived sessions (numbers
unchanged) with a USAGE column. Panes are sampled every second and the list
redraws the moment a session starts, closes or is archived; only changed
frames are drawn. Usage refreshes every 5 min.

--interactive: type a session number to open it (Enter or a short pause
settles multi-digit numbers), ctrl+c to close. Detaching (ctrl+b d) or the
session closing comes back to this list; after babysit open, start or fork in
a terminal that happens on its own.

USAGE column: the usage bar for the worst rate window of the session agent's
account, filled by the share used (extra usage, spend caps and balances do not
count); — while unknown.

Usage panel (--usage, --all): account usage per agent, one row per metered
limit with a bar, % used and time to reset. Balances and lifetime spend stay in
babysit usage. With two or more Claude accounts, each gets its own rows
(claude / <account>).

Options:
  --usage        Only the usage panel
  --all          Session tree plus the usage panel
  --interactive  Open a session by typing its number

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
session's workspace (a program cannot change its parent shell's directory).
Defaults to $SHELL.

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

Options:
  --force           Restart even when busy or without a captured id
  --detach          Return instead of attaching
  --continue        Tell the agent to continue unfinished work once it is back
  --account NAME    Claude: this subscription instead of the one with most headroom
                    (with several sessions or "all": its Claude sessions only)

Examples:
  babysit restart 1
  babysit restart 1 6 3
  babysit restart 1 --detach
  babysit restart all
  babysit restart abc-123 --force
  babysit restart 2 --account work --continue
  babysit restart all --account failover`,

    archive: () => `Usage: babysit archive <number|session_id|name>...

Dims sessions and sinks them to the bottom of their workspace in babysit list.
They keep running. babysit open un-archives one. Numbers mean the list as it
was before the first archive.

Examples:
  babysit archive 3
  babysit archive 2 5 6
  babysit archive "feature 1"`,

    prune: () => `Usage: babysit prune [--list]

Interactive cleanup. Docker: stopped containers, images no saved session
needs, unused networks, and build cache (Babysit containers, in-use images,
and volumes stay). Clones: managed clone workspaces by age. Each part asks
for its own confirmation.

Options:
  --list    Only list clone workspaces and their sizes (no prompts)

Examples:
  babysit prune
  babysit prune --list`,

    recover: () => `Usage: babysit recover [id|number] [--dry-run] [--json] [--no-continue]
       babysit recover init

Restarts sessions that were interrupted (reboot, Docker restart, crash), detached,
across workspaces. Each resumes its saved conversation and is told: "You were
interrupted. Check the current state, then continue unfinished work." Live
agents are left alone; closed sessions are never recovered.

Options:
  --dry-run       Show candidates and blockers; change nothing
  --json          Machine-readable results
  --no-continue   Reopen without sending the continuation message

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

Read-only overview: storage paths, Docker image and socket, launch-menu
defaults, auth checker, web bridge, and boot recovery status.

Example:
  babysit config`,

    doctor: () => `Usage: babysit doctor --auth [agent|all] [--refresh]

Real model-backed login check for every installed agent (or one): each runs a
tiny prompt in a throwaway container with the credentials sessions get.
Successes are cached 12h, which also lets launches skip their own check.

Options:
  --auth       Run the authentication diagnostic (required)
  --refresh    Ignore the 12h cache and probe again

Examples:
  babysit doctor --auth
  babysit doctor --auth claude
  babysit doctor --auth opencode --refresh`,

    auth: () => `Usage: babysit auth [status]
       babysit auth check [agent] [--force]
       babysit auth init [--remove] [--no-linger] [--claude-token | --no-claude-token]
       babysit auth init --claude-token --name NAME
       babysit auth accounts [remove NAME]

Keeps agent logins verified so launches start fast, and tells you when one
breaks. A launch or babysit doctor --auth verifies a login and caches it for
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
hits its limit, the monitor moves it to another account with headroom (resume
plus a continue prompt), never back to one it left while that limit window is
open, and never while you are attached: detach to let it switch
(config.claude_account_auto_switch, default true).
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
launch probes first.

Examples:
  babysit auth
  babysit auth status`,

    'auth check': () => `Usage: babysit auth check [agent] [--force]

What the scheduled checker runs. Only agents verified before are checked,
cheapest first: offline file checks, then a host CLI prompt once the last proof
is 1h old, then a container re-verify after 6h. A host probe waits while a
session might be refreshing the same token. Network failures never alert.
Skips when a launch or another check holds the authentication lease.

Options:
  agent      Check only this agent (${ SUPPORTED_AGENTS.join( `, ` ) })
  --force    Probe now regardless of age (session monitors use this)

Examples:
  babysit auth check
  babysit auth check codex
  babysit auth check claude --force`,

    'auth init': () => `Usage: babysit auth init [--remove] [--no-linger] [--claude-token | --no-claude-token]
       babysit auth init --claude-token --name NAME

1. Installs the 10-minute checker for your user: a systemd user timer on Linux
   (and enables lingering so it runs while you are logged out), a launchd agent
   on macOS. PUSHOVER_* set now are written into the schedule.
2. Offers a one-year Claude token when CLAUDE_CODE_OAUTH_TOKEN is unset: runs
   claude setup-token (approve in the browser), then asks you to paste the
   printed token, proves it with one prompt, and saves it to ~/.babysitrc
   (0600). Sessions then use it instead of the rotating /login token, so they
   stop logging each other out. Restart running Claude sessions to switch.
Rerun after upgrading Babysit to pick up schedule changes.
With --name NAME only step 2 runs, and the token becomes a named Claude account
(see babysit auth accounts --help) instead of replacing ~/.babysitrc.

Options:
  --remove            Uninstall the checker (the Claude token stays)
  --no-linger         Linux: leave lingering as it is (without it, checks stop when you log out;
                      undo an earlier enable with loginctl disable-linger)
  --claude-token      Mint a new Claude token even if one is set (e.g. after an alert)
  --no-claude-token   Skip the Claude token step
  --name NAME         Save the token as an extra Claude account; installs no checker

Examples:
  babysit auth init
  babysit auth init --claude-token
  babysit auth init --no-claude-token --no-linger
  babysit auth init --remove
  babysit auth init --claude-token --name work`,

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
keep their image; babysit restart moves one over.

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

}

// Flags whose next argument is a value, not a command word
const VALUE_FLAGS = new Set( [ `--name`, `--log`, `--port`, `--config`, `-n`, `--status`, `--sort`, `--limit`, `--auth-check-agents` ] )

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
    const agent = first === `agy` ? `antigravity` : first
    if( is_agent( agent ) ) return TOPICS[ second === `resume` ? `agent resume` : `agent` ]( agent )

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
