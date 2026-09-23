import { afterEach, expect, it } from 'bun:test'
import { opencode_catalog, resolve_model, resolve_opencode_model } from '../src/docker/assets/effort/catalog.mjs'

const original_fetch = globalThis.fetch
const original_env = { ...process.env }
afterEach( () => {
    globalThis.fetch = original_fetch
    for( const key of [ `BABYSIT_EFFORT_ENDPOINT`, `BABYSIT_EFFORT_SESSION_ID` ] ) {
        if( original_env[key] === undefined ) delete process.env[key]
        else process.env[key] = original_env[key]
    }
} )

const fixture = () => {
    process.env.BABYSIT_EFFORT_ENDPOINT = `http://127.0.0.1:12345`
    process.env.BABYSIT_EFFORT_SESSION_ID = `ses_test`
    const replies = {
        '/provider': { connected: [ `one` ], all: [
            { id: `one`, models: { selected: { name: `Selected`, variants: { low: {} } }, target: { name: `Target`, variants: { high: {} } } } },
            { id: `offline`, models: { hidden: { name: `Hidden` } } },
        ] },
        '/session/ses_test': { model: { providerID: `one`, id: `wrong` }, metadata: { babysit_effort: { provider_id: `one`, model_id: `selected`, level: `low` } } },
        '/session/ses_test/message': [ { info: { role: `user`, model: { providerID: `one`, modelID: `selected` } } } ],
    }
    globalThis.fetch = async url => Response.json( replies[new URL( url ).pathname] )
}

it( `lists only connected models and uses actual latest user selection`, async () => {
    fixture()
    const catalog = await opencode_catalog()
    expect( catalog.models.map( model => model.id ) ).toEqual( [ `one/selected`, `one/target` ] )
    expect( catalog.current.id ).toBe( `one/selected` )
    expect( catalog.current.effort ).toBe( `low` )
    expect( ( await resolve_opencode_model( `target` ) ).effort ).toBe( `default` )
    expect( ( await resolve_opencode_model( `Selected` ) ).effort ).toBe( `low` )
} )

it( `refuses ambiguous short names but accepts a full provider ID`, () => {
    const models = [ { id: `one/model`, model_id: `model` }, { id: `two/model`, model_id: `model` } ]
    expect( () => resolve_model( models, `model` ) ).toThrow( `Ambiguous` )
    expect( resolve_model( models, `two/model` ).id ).toBe( `two/model` )
    expect( () => resolve_model( models, `unknown` ) ).toThrow( `Unsupported` )
} )
