const metadata_key = `babysit_effort`

/** Change the requesting OpenCode session's reasoning override through its own server. */
export const effort = async level => {

    const session_id = process.env.BABYSIT_EFFORT_SESSION_ID
    if( !session_id || !/^ses[a-zA-Z0-9_]+$/.test( session_id ) ) {
        throw new Error( `OpenCode effort requires a shell tool in the requesting session; start it through Babysit.` )
    }

    const endpoint = new URL( process.env.BABYSIT_EFFORT_ENDPOINT )
    if( endpoint.protocol !== `http:` || ![ `127.0.0.1`, `localhost`, `[::1]` ].includes( endpoint.hostname ) ) {
        throw new Error( `OpenCode effort requires its local Babysit app server.` )
    }

    const headers = { 'content-type': `application/json` }
    if( process.env.BABYSIT_EFFORT_DIRECTORY ) headers[ `x-opencode-directory` ] = encodeURIComponent( process.env.BABYSIT_EFFORT_DIRECTORY )
    if( process.env.OPENCODE_SERVER_PASSWORD ) {
        const username = process.env.OPENCODE_SERVER_USERNAME || `opencode`
        headers.authorization = `Basic ${ Buffer.from( `${ username }:${ process.env.OPENCODE_SERVER_PASSWORD }` ).toString( `base64` ) }`
    }

    const request = async ( path, body ) => {
        const response = await fetch( new URL( path, endpoint ), {
            method: body ? `PATCH` : `GET`,
            headers,
            body: body ? JSON.stringify( body ) : undefined,
            signal: AbortSignal.timeout( 10_000 ),
        } )
        if( !response.ok ) throw new Error( `OpenCode control request failed (HTTP ${ response.status }).` )
        return response.json()
    }

    const path = `/session/${ session_id }`
    const session = await request( path )
    // The native v2 session.model can differ from the legacy TUI's actual inference model.
    const messages = await request( `${ path }/message` )
    const user = messages.findLast( message => message.info.role === `user` )?.info
    const model = user?.model ? { ...user.model, id: user.model.modelID } : session.model
    if( !model?.providerID || !model.id ) throw new Error( `OpenCode has not selected a model in this session yet.` )

    const providers = await request( `/provider` )
    const catalog_model = providers.all?.find( provider => provider.id === model.providerID )?.models?.[ model.id ]
    const levels = Object.keys( catalog_model?.variants || {} )
    const saved = session.metadata?.[ metadata_key ]
    const matches_model = saved?.provider_id === model.providerID && saved?.model_id === model.id
    const current = matches_model ? saved.level : undefined
    const choices = [ ...levels, `default` ].join( `, ` )

    if( level === undefined ) {
        return `OpenCode effort: ${ current ? `${ current } (Babysit override)` : `default (TUI selection)` }. Supported: ${ choices }. The stock TUI footer shows its own selection.`
    }
    if( level !== `default` && !levels.includes( level ) ) {
        throw new Error( `Unsupported effort '${ level }' for ${ model.providerID }/${ model.id }. Supported: ${ choices }.` )
    }

    // Store an override for this model only. A later model change must not inherit incompatible options.
    const override = level === `default` ? null : { level, provider_id: model.providerID, model_id: model.id }
    const metadata = { ...session.metadata, [ metadata_key ]: override }
    await request( path, { metadata } )
    const updated = await request( path )
    const retained = updated.metadata?.[ metadata_key ]
    const retained_override = override === null ? retained === null
        : retained?.level === level && retained?.provider_id === model.providerID && retained?.model_id === model.id
    if( !retained_override ) {
        throw new Error( `OpenCode did not retain the effort override; this server version may not support session metadata.` )
    }

    return level === `default`
        ? `OpenCode effort override cleared. Subsequent requests use the TUI selection.`
        : `OpenCode effort override set to ${ level } for subsequent requests, including this turn. Requests already running are unchanged. The stock TUI footer still shows its own selection; use 'babysit effort default' to restore it.`

}
