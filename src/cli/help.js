import { SUPPORTED_AGENTS } from '../agents/index.js'
import { help_topic } from './help_topics.js'
import { COMMANDS, OVERVIEW_FLAG_ROWS, format_rows } from './registry.js'

// Overview rows of one command context, in registry order
const command_rows = context => format_rows(
    COMMANDS.filter( command => ( command.context || `host` ) === context && command.usage ).flatMap( command => command.usage ),
    { width: 38 },
)

/**
 * Print help: the command's own page when argv names one, else the overview
 * @param {string[]} [argv=[]] - process.argv.slice(2)
 */
export const show_help = ( argv = [] ) => {

    const topic = help_topic( argv )
    if( topic ) return console.log( topic )

    const agents = SUPPORTED_AGENTS.join( `, ` )

    const help = `
babysit — supervisor for LLM coding agent CLIs

Usage:
${ command_rows( `host` ) }

In a session (managed agent container):
${ command_rows( `container` ) }

Agents: ${ agents }

Flags:
${ format_rows( OVERVIEW_FLAG_ROWS, { width: 16, wrap: true } ) }

Session numbers:
  open/close/archive/fork: Rows from babysit list (forks nest under their parent)
  resume:         Rows from babysit resume (use --all for global history)
  <agent> resume: Same resume rows; the selected session must match the agent
  recover:        Rows from babysit recover --dry-run (all workspaces)
  Numbers follow the current listing; use IDs for durable references.

Any unrecognised flags are passed through to the coding agent CLI.

Every command explains itself, with examples: babysit <command> [subcommand] --help
(or babysit help <command>), e.g. babysit auth --help, babysit auth init --help, babysit claude --help.
sit is a short name for babysit (installed beside it; shell-init also defines it and tab completion).

Examples:
  babysit claude --yolo
  babysit codex --name "feature 1"
  babysit codex --clone --name "feature 1"
  babysit codex --sandbox --loop
  babysit codex --ignore-host-agents-md
  babysit opencode --mudbox --yolo
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
  babysit fork 2 codex --clone
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
