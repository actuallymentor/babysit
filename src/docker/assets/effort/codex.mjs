import { connect_rpc } from './rpc.mjs'

// Catalogs and loaded threads can span several pages. Never guess from page one.
const list_all = async ( rpc, method ) => {
    const data = []
    let cursor
    do {
        const page = await rpc.request( method, { cursor, limit: 100 } )
        data.push( ...page.data )
        cursor = page.nextCursor
    } while( cursor )
    return data
}

/** Inspect or change the caller's current Codex model effort. */
export const effort = async level => {

    const rpc = await connect_rpc( process.env.BABYSIT_EFFORT_ENDPOINT )
    try {
        const loaded = await list_all( rpc, `thread/loaded/list` )
        const thread_id = process.env.CODEX_THREAD_ID || ( loaded.length === 1 ? loaded[0] : null )
        if( !thread_id || !loaded.includes( thread_id ) ) {
            throw new Error( `Cannot identify this running Codex thread. Run babysit effort from the agent's shell tool.` )
        }

        // Joining without overrides observes current settings; it must not restart
        // a dormant conversation or overwrite permissions/model configuration.
        const current = await rpc.request( `thread/resume`, { threadId: thread_id, excludeTurns: true } )
        const models = await list_all( rpc, `model/list` )
        const model = models.find( model => model.model === current.model || model.id === current.model )
        const levels = model?.supportedReasoningEfforts?.map( option => option.reasoningEffort ) || []
        if( !levels.length ) throw new Error( `Codex does not advertise effort levels for ${ current.model }` )
        if( level === undefined ) {
            return `Codex ${ current.model }: ${ current.reasoningEffort || model.defaultReasoningEffort } (future turns). Supported: ${ levels.join( `, ` ) }.`
        }
        if( !levels.includes( level ) ) throw new Error( `Unsupported effort '${ level }'. Supported: ${ levels.join( `, ` ) }.` )

        // Capture the target before mutating. A completed target is benign, but
        // another turn starting concurrently must not silently become our target.
        const turns = await rpc.request( `thread/turns/list`, {
            threadId: thread_id, limit: 1, sortDirection: `desc`, itemsView: `notLoaded`,
        } )
        const active = turns.data.find( turn => turn.status === `inProgress` )
        await rpc.request( `thread/settings/update`, { threadId: thread_id, effort: level } )
        if( !active ) return `Codex effort: ${ level }. Applies to future turns.`

        try {
            const result = await rpc.request( `turn/settings/update`, { threadId: thread_id, turnId: active.id, effort: level } )
            if( result.status === `targetUnavailable` ) {
                return `Codex effort: ${ level }. The active turn ended; applies to future turns.`
            }
            if( result.status !== `applied` ) throw new Error( `Unexpected status: ${ result.status }` )
            return `Codex effort: ${ level }. Applies to the next model request in this turn and future turns; a request already running is unchanged.`
        } catch ( error ) {
            throw new Error( `Future turns now use ${ level }, but updating the active turn failed: ${ error.message }` )
        }
    } finally {
        rpc.close()
    }

}
