import { afterEach, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { opencode_catalog } from '../src/docker/assets/effort/catalog.mjs'
import { effort } from '../src/docker/assets/effort/opencode.mjs'

const original_env = { ...process.env }
const original_fetch = globalThis.fetch
const roots = []
afterEach( () => {
    process.env = { ...original_env }
    globalThis.fetch = original_fetch
    for( const root of roots.splice( 0 ) ) rmSync( root, { recursive: true, force: true } )
} )

it( `uses confirmed native switches until a newer user message supersedes them`, async () => {
    const root = mkdtempSync( `/tmp/babysit-selection-` )
    roots.push( root )
    const launch_id = randomUUID()
    const session_id = `ses_selection`
    process.env.BABYSIT_CONTROL_ID = launch_id
    process.env.BABYSIT_CONTROL_TEST_ROOT = root
    process.env.BABYSIT_EFFORT_SESSION_ID = session_id
    process.env.BABYSIT_EFFORT_ENDPOINT = `http://127.0.0.1:12345`
    const directory = `${ root }/.babysit-control-${ launch_id }`
    mkdirSync( directory )
    const id = randomUUID()
    const completed_at = Date.now()
    writeFileSync( `${ directory }/selection.json`, JSON.stringify( {
        id, launch_id, session_id, operation: `model`, status: `applied`, completed_at,
        target: { provider_id: `one`, model_id: `new`, effort: `high` },
    } ) )
    const session = { metadata: {}, model: { providerID: `one`, id: `old` } }
    let created = completed_at - 1000
    globalThis.fetch = async ( url, options ) => {
        const path = new URL( url ).pathname
        if( path === `/provider` ) return Response.json( { connected: [ `one` ], all: [ { id: `one`, models: {
            old: { name: `Old`, variants: { low: {} } }, new: { name: `New`, variants: { high: {} } },
        } } ] } )
        if( path.endsWith( `/message` ) ) return Response.json( [ { info: { role: `user`, time: { created }, model: { providerID: `one`, modelID: `old` } } } ] )
        if( options.method === `PATCH` ) Object.assign( session, JSON.parse( options.body ) )
        return Response.json( session )
    }
    expect( ( await opencode_catalog() ).current ).toEqual( { id: `one/new`, provider_id: `one`, model_id: `new`, effort: `high` } )
    await effort( `high` )
    expect( session.metadata.babysit_effort ).toEqual( { provider_id: `one`, model_id: `new`, level: `high` } )
    created = completed_at + 1
    expect( ( await opencode_catalog() ).current.id ).toBe( `one/old` )
    await expect( effort( `high` ) ).rejects.toThrow( `Supported: low, default` )
    process.env.BABYSIT_EFFORT_SESSION_ID = `ses_other`
    created = completed_at - 1000
    expect( ( await opencode_catalog() ).current.id ).toBe( `one/old` )
} )
