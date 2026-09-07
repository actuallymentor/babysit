import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createServer } from 'node:http'
import { effort } from '../src/docker/assets/effort/opencode.mjs'
import { babysit_effort_plugin } from '../src/docker/assets/effort/opencode-plugin.mjs'

const session_id = `ses_babysit_test`
const other_id = `ses_other_test`
const model = { providerID: `openai`, id: `gpt-test`, variants: { low: { reasoningEffort: `low` }, high: { reasoningEffort: `high` } } }
let server, sessions, plugin, previous_env, writes, directory_header

beforeEach( async () => {
    previous_env = { ...process.env }
    sessions = {
        [ session_id ]: { model, metadata: { unrelated: `preserve` } },
        [ other_id ]: { model, metadata: {} },
    }
    writes = 0
    server = createServer( async ( request, response ) => {
        directory_header = request.headers[ `x-opencode-directory` ]
        response.setHeader( `content-type`, `application/json` )
        if( request.url === `/provider` ) return response.end( JSON.stringify( { all: [ { id: `openai`, models: { 'gpt-test': model } } ] } ) )
        const session = sessions[ request.url.split( `/` )[ 2 ] ]
        if( !session ) {
            response.writeHead( 404 ); return response.end( `{}` )
        }
        if( request.url.endsWith( `/message` ) ) return response.end( JSON.stringify( [ { info: { role: `user`, model: { providerID: model.providerID, modelID: model.id } } } ] ) )
        if( request.method === `PATCH` ) {
            let body = ``
            for await ( const chunk of request ) body += chunk
            Object.assign( session, JSON.parse( body ) )
            writes++
        }
        response.end( JSON.stringify( session ) )
    } )
    await new Promise( resolve => server.listen( 0, `127.0.0.1`, resolve ) )
    process.env.BABYSIT_EFFORT_ENDPOINT = `http://127.0.0.1:${ server.address().port }`
    process.env.BABYSIT_EFFORT_SESSION_ID = session_id
    plugin = await babysit_effort_plugin( { directory: `/tmp/project with spaces`, client: { session: { get: async ( { path } ) => ( { data: sessions[ path.id ] } ) } } } )
} )

afterEach( async () => {
    process.env = previous_env
    await new Promise( resolve => server.close( resolve ) )
} )

const next_request = async ( id = session_id, selected_model = model ) => {
    const output = { options: { reasoningEffort: `medium`, unrelated: true } }
    await plugin[ `chat.params` ]( { sessionID: id, model: selected_model }, output )
    return output.options
}

describe( `OpenCode effort server adapter and inference hook`, () => {

    it( `preserves the TUI request and warns when metadata lookup fails`, async () => {
        const warnings = []
        for( const get of [ async () => ( { error: `unavailable` } ), async () => {
            throw new Error( `connection closed` )
        } ] ) {
            const hooks = await babysit_effort_plugin( { client: {
                session: { get },
                app: { log: async ( { body } ) => {
                    warnings.push( body )
                    throw new Error( `Logging unavailable too` )
                } },
            } } )
            const output = { options: { reasoningEffort: `medium`, unrelated: true } }
            await hooks[ `chat.params` ]( { sessionID: session_id, model }, output )
            expect( output.options ).toEqual( { reasoningEffort: `medium`, unrelated: true } )
        }
        expect( warnings ).toHaveLength( 2 )
        expect( warnings[0].level ).toBe( `warn` )
    } )

    it( `changes effort in both directions for only the requesting session and resets to TUI defaults`, async () => {
        const shell = { env: {} }
        await plugin[ `shell.env` ]( { sessionID: session_id }, shell )
        expect( shell.env.BABYSIT_EFFORT_SESSION_ID ).toBe( session_id )
        expect( shell.env.BABYSIT_EFFORT_DIRECTORY ).toBe( `/tmp/project with spaces` )
        process.env.BABYSIT_EFFORT_DIRECTORY = shell.env.BABYSIT_EFFORT_DIRECTORY
        expect( await effort() ).toContain( `TUI selection` )
        expect( writes ).toBe( 0 )
        expect( directory_header ).toBe( encodeURIComponent( `/tmp/project with spaces` ) )
        expect( await effort( `high` ) ).toContain( `stock TUI footer` )
        expect( await next_request() ).toEqual( { reasoningEffort: `high`, unrelated: true } )
        expect( await next_request( other_id ) ).toEqual( { reasoningEffort: `medium`, unrelated: true } )
        expect( sessions[ session_id ].metadata.unrelated ).toBe( `preserve` )
        await effort( `low` )
        expect( ( await next_request() ).reasoningEffort ).toBe( `low` )
        expect( await effort() ).toContain( `low (Babysit override)` )
        await effort( `default` )
        expect( ( await next_request() ).reasoningEffort ).toBe( `medium` )
    } )

    it( `rejects unsupported levels and missing identity without modifying a session`, async () => {
        await expect( effort( `ultra` ) ).rejects.toThrow( `Supported: low, high, default` )
        delete process.env.BABYSIT_EFFORT_SESSION_ID
        await expect( effort( `high` ) ).rejects.toThrow( `requesting session` )
        expect( writes ).toBe( 0 )
    } )

    it( `does not carry an override to a different provider or model`, async () => {
        await effort( `high` )
        expect( ( await next_request( session_id, { ...model, id: `other-model` } ) ).reasoningEffort ).toBe( `medium` )
        expect( ( await next_request( session_id, { ...model, providerID: `other-provider` } ) ).reasoningEffort ).toBe( `medium` )
    } )

    it( `uses the actual user-message model even when v2 session settings disagree`, async () => {
        sessions[ session_id ].model = { providerID: `unused-provider`, id: `unused-model` }
        await effort( `high` )
        expect( ( await next_request() ).reasoningEffort ).toBe( `high` )
    } )

    it( `preserves unrelated provider options when applying a nested reasoning variant`, async () => {
        sessions[ session_id ].metadata.babysit_effort = { level: `high`, provider_id: model.providerID, model_id: model.id }
        const nested_model = { ...model, variants: { high: { reasoning: { effort: `high` } } } }
        const output = { options: { reasoning: { effort: `low`, exclude: true }, unrelated: true } }
        await plugin[ `chat.params` ]( { sessionID: session_id, model: nested_model }, output )
        expect( output.options ).toEqual( { reasoning: { effort: `high`, exclude: true }, unrelated: true } )
    } )

    it( `rejects nonlocal control endpoints`, async () => {
        process.env.BABYSIT_EFFORT_ENDPOINT = `https://example.com`
        await expect( effort( `high` ) ).rejects.toThrow( `local Babysit app server` )
        expect( writes ).toBe( 0 )
    } )

} )
