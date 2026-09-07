import { afterEach, describe, expect, it } from 'bun:test'
import { serve } from 'bun'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath( new URL( `../src/docker/assets/effort/bin.mjs`, import.meta.url ) )
const servers = []
afterEach( () => {
    for( const server of servers.splice( 0 ) ) server.stop( true )
} )

const fixture = ( overrides = {} ) => {
    const calls = []
    const replies = {
        initialize: {},
        'thread/loaded/list': { data: [ `mine` ] },
        'thread/resume': { model: `test-model`, reasoningEffort: `low` },
        'model/list': { data: [ { model: `test-model`, supportedReasoningEfforts: [ `low`, `medium`, `high` ].map( reasoningEffort => ( { reasoningEffort } ) ) } ] },
        'thread/turns/list': { data: [ { id: `turn-1`, status: `inProgress` } ] },
        'thread/settings/update': {},
        'turn/settings/update': { status: `applied` },
        ...overrides,
    }
    const server = serve( {
        hostname: `127.0.0.1`, port: 0,
        fetch( request, server ) {
            if( !server.upgrade( request ) ) return new Response( `upgrade required`, { status: 400 } )
        },
        websocket: {
            message( socket, raw ) {
                const message = JSON.parse( raw )
                if( message.id === undefined ) return
                calls.push( message )
                const reply = replies[message.method]
                socket.send( JSON.stringify( { id: message.id, ... reply?.error ? reply : { result: reply }  } ) )
            },
        },
    } )
    servers.push( server )
    return { endpoint: `ws://127.0.0.1:${ server.port }`, calls }
}

const run = ( args, endpoint, thread_id = `mine` ) => new Promise( resolve => {
    const child = spawn( `node`, [ helper, `effort`, ...args ], {
        env: { ...process.env, BABYSIT_EFFORT_AGENT: `codex`, BABYSIT_EFFORT_ENDPOINT: endpoint || ``, CODEX_THREAD_ID: thread_id },
        stdio: [ `ignore`, `pipe`, `pipe` ],
    } )
    let output = ``
    child.stdout.on( `data`, chunk => {
        output += chunk
    } )
    child.stderr.on( `data`, chunk => {
        output += chunk
    } )
    child.on( `close`, code => resolve( { code, output } ) )
} )

describe( `babysit effort Codex command`, () => {
    it( `changes both defaults and the exact active turn without changing the model`, async () => {
        const { endpoint, calls } = fixture()
        const result = await run( [ `medium` ], endpoint )
        expect( result.code ).toBe( 0 )
        expect( result.output ).toContain( `next model request` )
        expect( calls.filter( call => call.method.endsWith( `settings/update` ) ).map( ( { method, params } ) => ( { method, params } ) ) ).toEqual( [
            { method: `thread/settings/update`, params: { threadId: `mine`, effort: `medium` } },
            { method: `turn/settings/update`, params: { threadId: `mine`, turnId: `turn-1`, effort: `medium` } },
        ] )
    } )

    it( `rejects unadvertised values before any effort mutation`, async () => {
        const { endpoint, calls } = fixture()
        const result = await run( [ `ultra` ], endpoint )
        expect( result.code ).toBe( 1 )
        expect( result.output ).toContain( `Supported: low, medium, high` )
        expect( calls.some( call => call.method.endsWith( `settings/update` ) ) ).toBe( false )
    } )

    it( `lists current defaults and model-specific choices without mutation`, async () => {
        const { endpoint, calls } = fixture()
        const result = await run( [], endpoint )
        expect( result.code ).toBe( 0 )
        expect( result.output ).toContain( `test-model: low (future turns)` )
        expect( calls.some( call => call.method.endsWith( `settings/update` ) ) ).toBe( false )
    } )

    it( `does not resume a different or unloaded caller thread`, async () => {
        const { endpoint, calls } = fixture()
        expect( ( await run( [ `high` ], endpoint, `other` ) ).code ).toBe( 1 )
        expect( calls.some( call => call.method === `thread/resume` ) ).toBe( false )
    } )

    it( `refuses ambiguous sessions when the tool has no thread ID`, async () => {
        const { endpoint } = fixture( { 'thread/loaded/list': { data: [ `mine`, `other` ] } } )
        expect( ( await run( [ `high` ], endpoint, `` ) ).code ).toBe( 1 )
    } )

    it( `reports a completed-turn race as future-only success`, async () => {
        const { endpoint } = fixture( { 'turn/settings/update': { status: `targetUnavailable` } } )
        const result = await run( [ `low` ], endpoint )
        expect( result.code ).toBe( 0 )
        expect( result.output ).toContain( `active turn ended` )
    } )

    it( `reports partial failure honestly when active controls are unavailable`, async () => {
        const { endpoint } = fixture( { 'turn/settings/update': { error: { message: `feature disabled` } } } )
        const result = await run( [ `high` ], endpoint )
        expect( result.code ).toBe( 1 )
        expect( result.output ).toContain( `Future turns now use high, but updating the active turn failed` )
    } )

    it( `does not target a finished turn`, async () => {
        const { endpoint, calls } = fixture( { 'thread/turns/list': { data: [ { id: `done`, status: `completed` } ] } } )
        const result = await run( [ `low` ], endpoint )
        expect( result.code ).toBe( 0 )
        expect( calls.some( call => call.method === `turn/settings/update` ) ).toBe( false )
    } )

    it( `explains unsupported sessions and accepts help without a server`, async () => {
        expect( ( await run( [ `high` ] ) ).output ).toContain( `Effort control is unavailable` )
        expect( ( await run( [ `--help` ] ) ).code ).toBe( 0 )
        expect( ( await run( [ `high`, `low` ] ) ).code ).toBe( 1 )
    } )
} )
