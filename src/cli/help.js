import { SUPPORTED_AGENTS } from '../agents/index.js'

/**
 * Print the help message
 */
export const show_help = () => {

    const agents = SUPPORTED_AGENTS.join( `, ` )

    const help = `
babysit — supervisor for LLM coding agent CLIs

Usage:
  babysit <agent> [flags]              Start a new session
  babysit <agent> resume <id> [flags]  Resume a previous session
  babysit list [--all]                 List active sessions and launch flags
  babysit open [id|name|number]        Attach to an active session
  babysit resume [session_id] [flags]  List this workspace's sessions or resume one
  babysit config                       Configure babysit settings
  babysit doctor --auth [agent|all]    Verify real agent authentication
  babysit update                       Refresh babysit, ~/.agents, and the docker image (verbose)

Agents: ${ agents }

Flags:
  --yolo          Maximum agent autonomy (skip permissions, AGENT_AUTONOMY_MODE=yolo)
  --sandbox       Ephemeral container, no workspace mount
  --mudbox        Read-only workspace mount
  --clone         Work in a copy while mounting the original at /original
  --docker        Mount the host Docker socket for Docker-outside-of-Docker testing
  --yes           Skip safety confirmation prompts
  --ignore-host-agents-md
                  Keep host agent instructions, skills, and preferences out of the container
  --name NAME     Give the session a human-readable name
  --port PORT     Publish host PORT to the same container port
  --port H:C      Publish host port H to container port C
  --auth          With "babysit doctor", make real model-backed auth checks
  --refresh       With "babysit doctor --auth", bypass the 12-hour success cache
  --all           With "list", show full details; with "resume", show every workspace
  --loop          Override idle action with LOOP.md or "Keep going"
  --log[=PATH]    Append tmux output to PATH (default: .YYYY_MM_DD_HH_MM.babysit.log)
  -h, --help      Show this help
  -v, --version   Show version

Any unrecognised flags are passed through to the coding agent CLI.

Examples:
  babysit claude --yolo
  babysit codex --name "feature 1"
  babysit codex --clone --name "feature 1"
  babysit codex --sandbox --loop
  babysit codex --ignore-host-agents-md
  babysit gemini --mudbox --yolo
  babysit opencode resume abc-123 --yolo
  babysit doctor --auth
  babysit doctor --auth opencode --refresh
  babysit list
  babysit list --all
  babysit resume
  babysit resume --all
  babysit open
  babysit open 2
  babysit open "feature 1"
`

    console.log( help.trim() )

}
