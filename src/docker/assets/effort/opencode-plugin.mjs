const merge_options = ( target, variant ) => {
    for( const [ key, value ] of Object.entries( variant ) ) {
        if( [ `__proto__`, `constructor`, `prototype` ].includes( key ) ) continue
        if( value && typeof value === `object` && !Array.isArray( value ) ) {
            const existing = target[ key ]
            target[ key ] = merge_options( existing && typeof existing === `object` && !Array.isArray( existing ) ? { ...existing } : {}, value )
        } else target[ key ] = value
    }
    return target
}

/** Bridge the shell's exact session identity and apply its override at each inference boundary. */
export const babysit_effort_plugin = async ( { client, directory } ) => ( {

    'shell.env': async ( input, output ) => {
        if( input.sessionID ) output.env.BABYSIT_EFFORT_SESSION_ID = input.sessionID
        if( directory ) output.env.BABYSIT_EFFORT_DIRECTORY = directory
    },

    'chat.params': async ( input, output ) => {
        let response
        try {
            response = await client.session.get( { path: { id: input.sessionID } } )
            if( response.error ) throw new Error( `Effort lookup failed` )
        } catch {
            // Effort controls are additive: an unavailable metadata endpoint
            // must not prevent an otherwise valid model request from running.
            await client.app.log( { body: {
                service: `babysit`, level: `warn`,
                message: `Effort settings unavailable; using the TUI setting for this request.`,
            } } ).catch( () => {} )
            return
        }
        const override = response.data?.metadata?.babysit_effort
        if( !override || override.provider_id !== input.model.providerID || override.model_id !== input.model.id ) return

        const variant = input.model.variants?.[ override.level ]
        if( !variant ) return

        // OpenCode's native model-switch API does not update its legacy TUI inference loop.
        // This official hook runs after normal variant selection and before each provider request.
        merge_options( output.options, variant )
    },

} )
