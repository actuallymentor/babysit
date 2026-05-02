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
  babysit list                         List active sessions
  babysit open <session_id>            Attach to an active session
  babysit resume <session_id> [flags]  Resume a previous session
  babysit update                       Refresh babysit, ~/.agents, and the docker image (verbose)

Agents: ${ agents }

Flags:
  --yolo          Maximum agent autonomy (skip permissions, AGENT_AUTONOMY_MODE=yolo)
  --sandbox       Ephemeral container, no workspace mount
  --mudbox        Read-only workspace mount
  --loop          Override idle action with LOOP.md or "Keep going"
  -h, --help      Show this help
  -v, --version   Show version

Any unrecognised flags are passed through to the coding agent CLI.

Examples:
  babysit claude --yolo
  babysit codex --sandbox --loop
  babysit gemini --mudbox --yolo
  babysit opencode resume abc-123 --yolo
  babysit list
  babysit open babysit_myrepo_claude_1234567890
`

    console.log( help.trim() )

}
