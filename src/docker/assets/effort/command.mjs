import { createInterface } from 'node:readline'
import { effort as codex_effort } from './codex.mjs'
import { effort as opencode_effort } from './opencode.mjs'
import { model as codex_model } from './codex-model.mjs'
import { opencode_catalog, resolve_opencode_model } from './catalog.mjs'
import { terminal_request } from './terminal-client.mjs'
import { agy_catalog, resolve_agy_model } from './agy-catalog.mjs'
import { run_benchmarks, benchmarks_help } from './benchmarks.mjs'

export const effort_help = `Usage: babysit effort [level]
Run inside a managed agent session. Omit level to list supported values.
Changes are session-only. Native terminal controls queue for up to 60s when unsafe.
Use --status <request-id> to inspect a queued result.
OpenCode: 'default' restores the TUI's variant; overrides do not update its footer.

Examples:
  babysit effort
  babysit effort high
  babysit effort --status <request-id>`

export const model_help = `Usage: babysit model [model-name]
List models or switch within the current managed agent session.
With no arguments, append the top 30 benchmarks, sorted by coding; missing metrics show as —.
Preserves compatible effort, otherwise uses the new model's default.
Terminal controls queue for up to 60s; --status <request-id> reads the result.

${ benchmarks_help }

Examples:
  babysit model
  babysit model sonnet
  babysit model --benchmarks --sort cost --limit 10`

const parse_control = ( args, help ) => {
    if( args.length === 1 && [ `--help`, `-h` ].includes( args[0] ) ) return { help }
    if( args.length === 2 && args[0] === `--status` ) return { status_id: args[1] }
    if( args.length > 1 || args.some( arg => !arg || arg.startsWith( `-` ) ) ) throw new Error( help )
    return { value: args[0] }
}

/** Run the same command from the host CLI and the small container executable. */
export const exit_help = `Usage: babysit exit [--yes] [--status <request-id>]
Ends this session gracefully: the agent quits after its current turn and Babysit cleans up.
Asks for confirmation first; --yes skips the prompt once the user has explicitly asked you to exit.

Examples:
  babysit exit
  babysit exit --yes`

export const EXIT_CONFIRMATION = `You may only exit if the user explicitly told you to do so, not because you are done. Exit? Y/n `

export const stuck_help = `Usage: babysit stuck [--status <request-id>]
Marks this session "stuck" in babysit list until the user types into it.

Example:
  babysit stuck`

// Session-level requests the host monitor applies itself; no agent dialog involved.
const session_request = ( operation, help, args = [] ) => {
    if( args.includes( `--help` ) || args.includes( `-h` ) ) return help
    const status_index = args.indexOf( `--status` )
    if( !process.env.BABYSIT_CONTROL_ID ) throw new Error( `babysit ${ operation } runs inside a managed session` )
    return terminal_request( operation, status_index >= 0 ? { status_id: args[ status_index + 1 ] } : {} )
}

// Prompt on a terminal only. Agent tools hold stdin open or closed without a
// TTY; either way there is nobody to answer, so refuse instead of hanging.
const ask = ( question, { input = process.stdin, output = process.stdout } = {} ) => new Promise( resolve => {
    if( !input.isTTY ) return resolve( null )
    output.write( question )
    const lines = createInterface( { input } )
    let answered = false
    lines.once( `line`, line => {
        answered = true
        lines.close()
        input.unref?.()
        resolve( line.trim() )
    } )
    // Ctrl-D on the terminal: no answer given.
    lines.once( `close`, () => {
        if( !answered ) resolve( null )
    } )
} )

export const run_exit = async ( args, { confirm = ask, request = session_request } = {} ) => {
    const skip = args.includes( `--yes` ) || args.includes( `-y` )
    const passthrough = args.filter( arg => ![ `--yes`, `-y` ].includes( arg ) )
    // A status query must never turn into an exit request: insist on its id.
    const status_index = passthrough.indexOf( `--status` )
    if( status_index >= 0 && !passthrough[ status_index + 1 ] ) throw new Error( exit_help )
    if( skip || status_index >= 0 || passthrough.includes( `--help` ) || passthrough.includes( `-h` ) ) {
        return request( `exit`, exit_help, passthrough )
    }
    const answer = await confirm( EXIT_CONFIRMATION )
    if( answer === null ) throw new Error( `${ EXIT_CONFIRMATION.trim() }\nNo terminal to answer on. If the user explicitly asked you to exit, run: babysit exit --yes` )
    if( ![ ``, `y`, `yes` ].includes( answer.toLowerCase() ) ) throw new Error( `Exit cancelled.` )
    return request( `exit`, exit_help, passthrough )
}

/** Flag this session as blocked on the user. */
export const run_stuck = args => session_request( `stuck`, stuck_help, args )

export const loop_help = `Usage: babysit loop [--status <request-id>]
Toggles --loop for this session: when idle, Babysit types LOOP.md (or "Keep going").

Example:
  babysit loop`

/** Toggle looping on this session. */
export const run_loop = args => session_request( `loop`, loop_help, args )

export const run_effort = async args => {
    const parsed = parse_control( args, effort_help )
    if( parsed.help ) return parsed.help
    const agent = process.env.BABYSIT_EFFORT_AGENT || process.env.BABYSIT_CONTROL_AGENT
    if( parsed.status_id || [ `claude`, `antigravity` ].includes( agent ) ) return terminal_request( `effort`, parsed )
    if( !process.env.BABYSIT_EFFORT_ENDPOINT ) {
        throw new Error( `Effort control is unavailable. Run this command inside a newly started managed agent session with a supported CLI and model.` )
    }
    switch ( agent ) {
    case `codex`: return codex_effort( parsed.value )
    case `opencode`: return opencode_effort( parsed.value )
    default: throw new Error( `Effort control is unavailable for this agent session.` )
    }
}

/** List or switch models in the caller's agent; never migrate conversations. */
const model_control = async args => {
    const parsed = parse_control( args, model_help )
    if( parsed.help ) return parsed.help
    if( parsed.status_id ) return terminal_request( `model`, parsed )
    const agent = process.env.BABYSIT_EFFORT_AGENT || process.env.BABYSIT_CONTROL_AGENT
    if( agent === `codex` && process.env.BABYSIT_EFFORT_ENDPOINT ) return codex_model( parsed.value )
    if( agent === `opencode` && process.env.BABYSIT_EFFORT_ENDPOINT ) {
        if( parsed.value === undefined ) {
            const { models, current } = await opencode_catalog()
            return [ `OpenCode model: ${ current?.id || `not selected` }. Connected models:`,
                ...models.map( model => `${ model.id } — ${ model.name }; efforts: ${ model.efforts.join( `, ` ) || `default` }` ),
            ].join( `\n` )
        }
        const target = await resolve_opencode_model( parsed.value )
        return terminal_request( `model`, { value: target.id, target } )
    }
    if( agent === `antigravity` ) {
        if( parsed.value === undefined ) {
            const { models } = await agy_catalog()
            return [ `Antigravity models:`, ...models.map( model => `${ model.id } — ${ model.name }` ) ].join( `\n` )
        }
        const target = await resolve_agy_model( parsed.value )
        return terminal_request( `model`, { value: target.id, target } )
    }
    if( agent === `claude` ) return terminal_request( `model`, parsed )
    throw new Error( `Model control is unavailable. Run inside a newly started managed agent session.` )
}

/** Supplement bare model listings without making benchmarks a control dependency. */
export const run_model = async ( args, { control = model_control, benchmarks = run_benchmarks } = {} ) => {
    if( args.includes( `--benchmarks` ) ) return benchmarks( args )
    const result = await control( args )
    if( args.length ) return result
    try {
        return `${ result }\n\n${ await benchmarks( [ `--benchmarks`, `--limit`, `30` ] ) }`
    } catch ( error ) {
        // A missing API key or offline endpoint must not hide available models.
        return `${ result }\n\n${ error.message }`
    }
}
