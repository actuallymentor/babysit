import { connect_rpc } from './rpc.mjs'
import { list_all } from './codex.mjs'

/** List the caller's catalog or change only its model and compatible reasoning setting. */
export const model = async name => {

    const rpc = await connect_rpc( process.env.BABYSIT_EFFORT_ENDPOINT )
    try {
        const loaded = await list_all( rpc, `thread/loaded/list` )
        const thread_id = process.env.CODEX_THREAD_ID || ( loaded.length === 1 ? loaded[0] : null )
        if( !thread_id || !loaded.includes( thread_id ) ) throw new Error( `Cannot identify this running Codex thread. Run babysit model from the agent's shell tool.` )

        const current = await rpc.request( `thread/resume`, { threadId: thread_id, excludeTurns: true } )
        const models = await list_all( rpc, `model/list` )
        const previous = models.find( item => item.model === current.model || item.id === current.model )
        const current_effort = current.reasoningEffort || previous?.defaultReasoningEffort
        if( name === undefined ) return [
            `Codex model: ${ current.model }; effort: ${ current_effort || `default` } (future turns). Available:`,
            ...models.map( item => `${ item.model }${ item.model === current.model ? ` (current)` : `` } — ${ item.displayName || item.model }; efforts: ${ item.supportedReasoningEfforts.map( option => option.reasoningEffort ).join( `, ` ) || `none` }` ),
        ].join( `\n` )

        const target = models.find( item => item.model === name || item.id === name )
        if( !target ) throw new Error( `Unsupported Codex model '${ name }'. Run babysit model to list available models.` )
        const levels = target.supportedReasoningEfforts.map( option => option.reasoningEffort )
        const effort = levels.includes( current_effort ) ? current_effort : target.defaultReasoningEffort
        const adjusted = effort !== current_effort ? ` Effort changed from ${ current_effort || `default` } to ${ effort || `default` } for this model.` : ``
        const settings = { model: target.model, ...effort ? { effort } : {} }

        // Capture one turn before publishing defaults. Never accidentally switch a newer turn.
        const turns = await rpc.request( `thread/turns/list`, { threadId: thread_id, limit: 1, sortDirection: `desc`, itemsView: `notLoaded` } )
        const active = turns.data.find( turn => turn.status === `inProgress` )
        await rpc.request( `thread/settings/update`, { threadId: thread_id, ...settings } )
        if( !active ) return `Codex model: ${ target.model }. Applies to future turns.${ adjusted }`
        try {
            const result = await rpc.request( `turn/settings/update`, { threadId: thread_id, turnId: active.id, ...settings } )
            if( result.status === `targetUnavailable` ) return `Codex model: ${ target.model }. The active turn ended; applies to future turns.${ adjusted }`
            if( result.status !== `applied` ) throw new Error( `Unexpected status: ${ result.status }` )
            return `Codex model: ${ target.model }. Applies to the next model request in this turn and future turns; a request already running is unchanged.${ adjusted }`
        } catch ( error ) {
            throw new Error( `Future turns now use ${ target.model }, but updating the active turn failed: ${ error.message }.${ adjusted }` )
        }
    } finally {
        rpc.close()
    }

}
