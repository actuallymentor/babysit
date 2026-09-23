import { read_control_selection } from './control-store.mjs'

/** Resolve an exact provider/model ID, or an unambiguous short ID/display name. */
export const resolve_model = ( models, name ) => {
    const exact = models.find( model => model.id === name )
    if( exact ) return exact
    const matches = models.filter( model => model.model_id === name || model.name === name )
    if( matches.length === 1 ) return matches[0]
    if( matches.length > 1 ) throw new Error( `Ambiguous model '${ name }'. Use a provider/model ID.` )
    throw new Error( `Unsupported model '${ name }'. Run babysit model to list available models.` )
}

/** Bridge the gap before the next user message records a Babysit-confirmed TUI switch. */
export const opencode_selection = ( session_id, session, user ) => {
    const confirmed = read_control_selection( { session_id, after: user?.time?.created || 0 } )
    // Only our confirmed switch is observable before another prompt. Manual native
    // picker changes become authoritative when their next user message arrives.
    if( confirmed?.provider_id && confirmed?.model_id ) return {
        providerID: confirmed.provider_id, modelID: confirmed.model_id, variant: confirmed.effort || `default`,
    }
    if( user?.model ) return { ...user.model, variant: user.variant || `default` }
    if( session.model ) return { providerID: session.model.providerID, modelID: session.model.id, variant: `default` }
    return null
}

/** Read connected OpenCode models and the requesting session's actual TUI selection. */
export const opencode_catalog = async () => {
    const endpoint = new URL( process.env.BABYSIT_EFFORT_ENDPOINT )
    if( endpoint.protocol !== `http:` || ![ `127.0.0.1`, `localhost`, `[::1]` ].includes( endpoint.hostname ) ) throw new Error( `OpenCode model control requires its local Babysit app server.` )
    const headers = { 'content-type': `application/json` }
    if( process.env.BABYSIT_EFFORT_DIRECTORY ) headers[ `x-opencode-directory` ] = encodeURIComponent( process.env.BABYSIT_EFFORT_DIRECTORY )
    if( process.env.OPENCODE_SERVER_PASSWORD ) headers.authorization = `Basic ${ Buffer.from( `${ process.env.OPENCODE_SERVER_USERNAME || `opencode` }:${ process.env.OPENCODE_SERVER_PASSWORD }` ).toString( `base64` ) }`
    const request = async ( path, body, method = `POST` ) => {
        const response = await fetch( new URL( path, endpoint ), { method: body === undefined ? `GET` : method, headers, body: body === undefined ? undefined : JSON.stringify( body ), signal: AbortSignal.timeout( 10_000 ) } )
        if( !response.ok ) throw new Error( `OpenCode catalog request failed (HTTP ${ response.status }).` )
        return response.status === 204 ? null : response.json()
    }
    const providers = await request( `/provider` )
    const models = providers.all.filter( provider => providers.connected.includes( provider.id ) ).flatMap( provider => Object.entries( provider.models ).map( ( [ model_id, model ] ) => ( {
        id: `${ provider.id }/${ model_id }`, provider_id: provider.id, model_id,
        name: model.name || model_id, efforts: Object.keys( model.variants || {} ), default_effort: `default`,
    } ) ) )
    const session_id = process.env.BABYSIT_EFFORT_SESSION_ID
    if( !session_id ) return { models, current: null, session_id: null, request }
    if( !/^ses[a-zA-Z0-9_]+$/.test( session_id ) ) throw new Error( `Invalid OpenCode session identity.` )
    const session = await request( `/session/${ session_id }` )
    const messages = await request( `/session/${ session_id }/message` )
    const user = messages.findLast( message => message.info.role === `user` )?.info
    const selected = opencode_selection( session_id, session, user )
    const saved = session.metadata?.babysit_effort
    const effort = saved?.provider_id === selected?.providerID && saved?.model_id === selected?.modelID ? saved.level : selected?.variant || `default`
    const current = selected ? { id: `${ selected.providerID }/${ selected.modelID }`, provider_id: selected.providerID, model_id: selected.modelID, effort } : null
    return { models, current, session_id, request }
}

/** Resolve one connected model for the host's native OpenCode picker. */
export const resolve_opencode_model = async name => {
    const { models, current } = await opencode_catalog()
    const target = resolve_model( models, name )
    const effort = target.efforts.includes( current?.effort ) ? current.effort : `default`
    return { ...target, providerID: target.provider_id, modelID: target.model_id, effort,
        notice: current?.effort && effort !== current.effort ? `Effort changed from ${ current.effort } to default for this model.` : `` }
}
