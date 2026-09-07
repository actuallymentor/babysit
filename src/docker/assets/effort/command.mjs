import { effort as codex_effort } from './codex.mjs'
import { effort as opencode_effort } from './opencode.mjs'

export const effort_help = `Usage: babysit effort [level]
Run inside a managed Codex or OpenCode session. Omit level to list supported values.
Changes apply to the next model request, including within a running turn.
OpenCode: use 'default' to restore the TUI's variant; overrides do not update its footer.`

/** Run the same command from the host CLI and the small container executable. */
export const run_effort = async args => {
    if( args.length === 1 && [ `--help`, `-h` ].includes( args[0] ) ) return effort_help
    if( args.length > 1 || args.some( arg => !arg || arg.startsWith( `-` ) ) ) throw new Error( effort_help )
    if( !process.env.BABYSIT_EFFORT_ENDPOINT ) {
        throw new Error( `Effort control is unavailable. Run this command inside a newly started managed Codex or OpenCode session with a supported CLI and model.` )
    }
    switch ( process.env.BABYSIT_EFFORT_AGENT ) {
    case `codex`: return codex_effort( args[0] )
    case `opencode`: return opencode_effort( args[0] )
    default: throw new Error( `Effort control supports Codex and OpenCode sessions only.` )
    }
}
