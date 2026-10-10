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
  --ignore-host-agents-md   Leave out host instructions, skills, preferences, and ~/.babysitrc setup; keep credentials
  --name NAME               Human-readable session name (shown in babysit list, usable with open)
  --config FILE             Use FILE instead of ./babysit.yaml; kept on resume and in clones
  --port PORT | H:C         Publish a port; repeatable
  --loop                    When idle, type ./LOOP.md, ~/.agents/LOOP.md, or "Keep going"
  --log[=PATH]              Append raw tmux output to PATH (default .YYYY_MM_DD_HH_MM.babysit.log)

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

    init: () => `Usage: babysit init [file.yaml]

Writes a commented default supervision config. Without a file name it asks for
one (default babysit.yaml). Rules run top-down; the first match wins:
  on:      idle | literal text | /regex/flags (matched against the last 10 pane lines)
  do:      enter | a config.commands name | text | ./FILE.md (=== separates steps)
  timeout: idle rules only, SS | MM:SS | HH:MM:SS

Use a non-default name with --config FILE on launch.

Examples:
  babysit init
  babysit init review.yaml
  babysit codex --config review.yaml`,

    list: () => `Usage: babysit list [--all] [--watch]

Active sessions as a tree: workspace trunks with numbered leaves, colored status
(idle grey, running green, waiting orange, stuck red), container CPU/MEM, and a
totals row. Numbers are what open, close, archive, and restart accept.

Options:
  --all      Add tmux attachment, session IDs, and tmux names
  --watch    Redraw every 2s; hides archived sessions, numbering unchanged

Examples:
  babysit list
  babysit list --all
  babysit list --watch`,

    open: () => `Usage: babysit open [id|name|number]

Attaches to an active session. Without a selector it attaches to this
directory's only session, or lists them when there are several. Opening an
archived session un-archives it.

Examples:
  babysit open
  babysit open 2                 Row 2 of babysit list
  babysit open "feature 1"`,

    close: () => `Usage: babysit close <number|session_id>

Closes a session on purpose: the agent stops, the container is removed, and
recovery will not bring this launch back. Resume it later with babysit resume.

Examples:
  babysit close 2
  babysit close abc-123`,

    restart: () => `Usage: babysit restart <number|session_id> [--force] [--detach]

Closes the session gracefully and resumes it on the current image, continuing
the agent's own conversation id. Use it after babysit update. Refuses unless
the agent is idle or waiting and its native session id was captured.
Sandbox sessions cannot be restarted.

Options:
  --force    Restart even when busy or without a captured id
  --detach   Return instead of attaching

Examples:
  babysit restart 1
  babysit restart 1 --detach
  babysit restart abc-123 --force`,

    archive: () => `Usage: babysit archive <number|session_id|name>

Dims a session and sinks it to the bottom of its workspace in babysit list.
It keeps running. babysit open un-archives it.

Examples:
  babysit archive 3
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
       babysit auth relogin [claude] [--session-key]

Keeps agent logins verified so launches start fast, and tells you when one
breaks. A launch or babysit doctor --auth verifies a login and caches it for
12h. The checker (installed by babysit auth init) runs babysit auth check every
10 minutes to keep those entries warm and catch logouts:
  offline        every run: credential file deleted, Claude refresh token expired
  host CLI       after 1h: one ~3s prompt through your own claude/codex
  container      after 6h: re-verifies and refreshes the launch cache
  session pane   a session showing the agent's logged-out message triggers a check
With PUSHOVER_TOKEN and PUSHOVER_USER (e.g. in ~/.babysitrc) it pushes logout
alerts and usage alerts at 90%. With GMAIL_USER and GMAIL_APP_PASSWORD it first
tries to log Claude back in by itself (babysit auth relogin --help).

Subcommands:
  status    Cache ages and checker state (default)
  check     What the checker runs (babysit auth check --help)
  init      Install the checker and the Claude token (babysit auth init --help)
  relogin   Log Claude back in through a browser container (babysit auth relogin --help)

Examples:
  babysit auth
  babysit auth init
  babysit auth check claude --force`,

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

1. Installs the 10-minute checker for your user: a systemd user timer on Linux
   (and enables lingering so it runs while you are logged out), a launchd agent
   on macOS. PUSHOVER_* set now are written into the schedule.
2. Offers a one-year Claude token when CLAUDE_CODE_OAUTH_TOKEN is unset: runs
   claude setup-token (approve in the browser), then asks you to paste the
   printed token, proves it with one prompt, and saves it to ~/.babysitrc
   (0600). Sessions then use it instead of the rotating /login token, so they
   stop logging each other out. Restart running Claude sessions to switch.
Rerun after upgrading Babysit to pick up schedule changes.

Options:
  --remove            Uninstall the checker (the Claude token stays)
  --no-linger         Linux: leave lingering as it is (without it, checks stop when you log out;
                      undo an earlier enable with loginctl disable-linger)
  --claude-token      Mint a new Claude token even if one is set (e.g. after an alert)
  --no-claude-token   Skip the Claude token step

Examples:
  babysit auth init
  babysit auth init --claude-token
  babysit auth init --no-claude-token --no-linger
  babysit auth init --remove`,

    'auth relogin': () => `Usage: babysit auth relogin [claude] [--session-key]

Logs Claude back in without you. A throwaway babysit container runs the claude
CLI and approves its sign-in page in a Chrome profile that keeps a claude.ai
session (Docker volume babysit-relogin). The result replaces the dead login:
  setup-token in use   a new CLAUDE_CODE_OAUTH_TOKEN in ~/.babysitrc
                       (restart running Claude sessions to use it)
  /login (Linux file)  a new login in ~/.claude/.credentials.json
                       (running sessions pick it up)
If the claude.ai session has expired, it requests a login email and opens the
link from Gmail: only mail from anthropic.com, claude.ai or claude.com that
Gmail verified (DKIM), sent after the request, is used. A Cloudflare human
check is never solved; the run stops and alerts. The browser must be signed in
as the expected account (CLAUDE_LOGIN_EMAIL, else the host's last /login), or
nothing is authorized. Each new login is proven with one container check.

babysit auth check runs this automatically on a confirmed Claude logout when
GMAIL_USER and GMAIL_APP_PASSWORD are set: once per logout, at most 3 times a
day. BABYSIT_RELOGIN=0 turns that off. Running it by hand ignores the limits.

Setup, once (in ~/.babysitrc):
  GMAIL_USER, GMAIL_APP_PASSWORD   Gmail box and app password that receive the login mail
  CLAUDE_LOGIN_EMAIL               Claude account address, when Claude mail is forwarded
                                   into Gmail (default: the host's last /login, else GMAIL_USER)
Then seed the browser: babysit auth relogin --session-key

Options:
  --session-key   Paste a claude.ai sessionKey cookie first (from a private window
                  where you logged in; close it without logging out)

Examples:
  babysit auth relogin --session-key
  babysit auth relogin
  BABYSIT_RELOGIN=0 babysit auth check`,

    web: () => `Usage: babysit web init

Babysit Web is a mobile companion for your sessions (see babysit web init --help).

Example:
  babysit web init`,

    'web init': () => `Usage: babysit web init

Creates the bridge directory the web companion reads and prints its access
token. Rerun to rotate the token, which also logs out every browser.
Running sessions discover the bridge; start the companion with Docker Compose
(see examples/compose.web*.yml).

Examples:
  babysit web init
  BABYSIT_WEB_UID="$(id -u)" BABYSIT_WEB_GID="$(id -g)" docker compose -f examples/compose.web.local.yml up --build -d`,

    update: () => `Usage: babysit update

Updates Babysit itself, the ~/.agents repository, the Docker image (120s pull
limit), and the host agent CLIs, then shows the image version. Nothing updates
implicitly. Running sessions keep their image; babysit restart moves one over.

Example:
  babysit update`,

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
