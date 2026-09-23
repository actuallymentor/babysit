import { effort as codex_effort } from './codex.mjs'
import { effort as opencode_effort } from './opencode.mjs'
import { model as codex_model } from './codex-model.mjs'
import { opencode_catalog, resolve_opencode_model } from './catalog.mjs'
import { terminal_request } from './terminal-client.mjs'
import { agy_catalog, resolve_agy_model } from './agy-catalog.mjs'

export const effort_help = `Usage: babysit effort [level]
Run inside a managed agent session. Omit level to list supported values.
Changes are session-only. Native terminal controls queue for up to 60s when unsafe.
Use --status <request-id> to inspect a queued result.
OpenCode: 'default' restores the TUI's variant; overrides do not update its footer.`

export const model_help = `Usage: babysit model [model-name]
List models or switch within the current managed agent session.
Preserves compatible effort, otherwise uses the new model's default.
Terminal controls queue for up to 60s; --status <request-id> reads the result.`

const parse_control = ( args, help ) => {
    if( args.length === 1 && [ `--help`, `-h` ].includes( args[0] ) ) return { help }
    if( args.length === 2 && args[0] === `--status` ) return { status_id: args[1] }
    if( args.length > 1 || args.some( arg => !arg || arg.startsWith( `-` ) ) ) throw new Error( help )
    return { value: args[0] }
}

/** Run the same command from the host CLI and the small container executable. */
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
export const run_model = async args => {
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
