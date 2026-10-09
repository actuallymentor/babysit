import { SUPPORTED_AGENTS } from '../agents/index.js'

/**
 * Print the help message
 */
export const show_help = () => {

    const agents = SUPPORTED_AGENTS.join( `, ` )

    const help = `
babysit — supervisor for LLM coding agent CLIs

Usage:
  babysit ["session name"]           Open the interactive launch menu
  babysit <agent> [flags]              Start a new session
  babysit <agent> resume <id|number>  Resume a previous session
  babysit init [file.yaml]             Write a commented default config; asks for the file name
  babysit list [--all] [--watch]       List active sessions and launch flags; --watch redraws every 2s, hiding archived
  babysit open [id|name|number]        Attach to an active session
  babysit resume [id|number] [flags]  List this workspace's sessions or resume one
  babysit prune [--list]               Prune unused Docker data and clone workspaces
  babysit recover [id|number]         Recover interrupted sessions, detached
  babysit recover init                Install this account's Ubuntu boot recovery service
  babysit close <number|session_id>    Close intentionally; disable recovery for this launch
  babysit restart <number|session_id>  Rebuild an idle session on the current image, keeping the conversation; --force, --detach
  babysit archive <number|session_id>  Dim a session and sink it to the bottom of babysit list; open un-archives
  babysit config                       Show settings and setup status
  babysit effort [level]               Inspect/change effort inside a managed agent session
  babysit model [model-name]           List/change models in the current agent session
  babysit model --benchmarks           Compare benchmarks; --sort coding is default
  babysit exit [--yes]                 Inside a session: end it gracefully after the current turn (asks first)
  babysit stuck                        Inside a session: show "stuck" in babysit list until the user types
  babysit loop                         Inside a session: toggle --loop (list flags and tmux bar follow)
  babysit usage [--json]               Account usage and limits, on host or in container
  babysit web init                     Initialize or rotate babysit-web access
  babysit doctor --auth [agent|all]    Verify real agent authentication
  babysit auth [status]                Show cached authentication ages and the checker state
  babysit auth check                   Re-verify stale cached logins quietly (what the checker runs)
  babysit auth init [--remove]         Install (or remove) the hourly host-level auth checker
                                       Linux: also enables user lingering; --no-linger opts out
  babysit update                       Refresh babysit, ~/.agents, and the docker image (verbose)

Agents: ${ agents }

Flags:
  --yolo          Maximum agent autonomy (skip permissions, AGENT_AUTONOMY_MODE=yolo)
  --sandbox       Ephemeral container, no workspace mount
  --mudbox        Read-only workspace mount
  --clone         Work in a copy while mounting the original at /original
  --docker        Mount the host Docker socket for Docker-outside-of-Docker testing
  --adb           Android Debug Bridge access with adb keys shared across sessions
  --yes           Skip clone safety confirmation prompts
  --ignore-host-agents-md
                  Keep host agent instructions, skills, and preferences out of the container
  --name NAME     Give the session a human-readable name
  --config FILE   Use FILE instead of ./babysit.yaml for this session (kept on resume)
  --port PORT     Publish host PORT to the same container port
  --port H:C      Publish host port H to container port C
  --auth          With "babysit doctor", make real model-backed auth checks
  --refresh       With "babysit doctor --auth", bypass the 12-hour success cache
  --remove        With "babysit auth init", uninstall the scheduled checker
  --no-linger     With "babysit auth init", do not enable loginctl lingering (checks then stop at logout)
  --all           With "list", show full details; with "resume [number]", use every workspace and show every row
  -n N            With "resume", show N history rows (default 10)
  --dry-run       With "recover", inspect without restarting
  --json          With "recover", print machine-readable results
  --no-continue   With "recover", reopen without submitting a continuation
  --list          With "prune", list clone workspaces and directory sizes
  --loop          Override idle action with LOOP.md or "Keep going"
  --log[=PATH]    Append tmux output to PATH (default: .YYYY_MM_DD_HH_MM.babysit.log)
  -h, --help      Show this help
  -v, --version   Show version

Session numbers:
  open/close/archive: Rows from babysit list
  resume:         Rows from babysit resume (use --all for global history)
  <agent> resume: Same resume rows; the selected session must match the agent
  recover:        Rows from babysit recover --dry-run (all workspaces)
  Numbers follow the current listing; use IDs for durable references.

Any unrecognised flags are passed through to the coding agent CLI.

Examples:
  babysit claude --yolo
  babysit codex --name "feature 1"
  babysit codex --clone --name "feature 1"
  babysit codex --sandbox --loop
  babysit codex --ignore-host-agents-md
  babysit antigravity --mudbox --yolo
  babysit opencode resume abc-123 --yolo
  babysit doctor --auth
  babysit doctor --auth opencode --refresh
  babysit auth init
  babysit auth status
  babysit list
  babysit list --all
  babysit resume
  babysit resume --all
  babysit resume 1
  babysit resume 1 --all
  babysit recover --dry-run
  babysit recover 1
  babysit prune
  babysit prune --list
  babysit web init
  babysit open
  babysit open 2
  babysit open "feature 1"
`

    console.log( help.trim() )

}
