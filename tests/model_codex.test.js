import { afterEach, describe, expect, it } from 'bun:test'
import { serve } from 'bun'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath( new URL( `../src/docker/assets/effort/codex-model.mjs`, import.meta.url ) )
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
        'model/list': { data: [ { model: `test-model`, defaultReasoningEffort: `medium`, supportedReasoningEfforts: [ `low`, `medium`, `high` ].map( reasoningEffort => ( { reasoningEffort } ) ) }, { model: `target`, defaultReasoningEffort: `medium`, supportedReasoningEfforts: [ { reasoningEffort: `medium` }, { reasoningEffort: `high` } ] } ] },
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
                const candidate = replies[message.method]
                const reply = typeof candidate === `function` ? candidate( message.params ) : candidate
                socket.send( JSON.stringify( { id: message.id, ... reply?.error ? reply : { result: reply }  } ) )
            },
        },
    } )
    servers.push( server )
    return { endpoint: `ws://127.0.0.1:${ server.port }`, calls }
}

const run = ( args, endpoint, thread_id = `mine` ) => new Promise( resolve => {
    const child = spawn( `node`, [ `--input-type=module`, `-e`, `import { model } from ${ JSON.stringify( `file://${ helper }` ) }; model(process.argv[1]).then(console.log).catch(error => { console.error(error.message); process.exitCode = 1 })`, ...args ], {
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

describe( `Codex model controls`, () => {
    it( `changes the exact thread and active turn, resetting incompatible effort only`, async () => {
        const { endpoint, calls } = fixture()
        const result = await run( [ `target` ], endpoint )
        expect( result.code ).toBe( 0 )
        expect( result.output ).toContain( `Effort changed from low to medium` )
        expect( calls.filter( call => call.method.endsWith( `settings/update` ) ).map( call => call.params ) ).toEqual( [
            { threadId: `mine`, model: `target`, effort: `medium` },
            { threadId: `mine`, turnId: `turn-1`, model: `target`, effort: `medium` },
        ] )
    } )
    it( `preserves compatible effort`, async () => {
        const { endpoint, calls } = fixture( { 'thread/resume': { model: `test-model`, reasoningEffort: `high` } } )
        expect( ( await run( [ `target` ], endpoint ) ).code ).toBe( 0 )
        expect( calls.find( call => call.method === `thread/settings/update` ).params.effort ).toBe( `high` )
    } )
    it( `lists without mutation and rejects invalid names`, async () => {
        const { endpoint, calls } = fixture()
        expect( ( await run( [], endpoint ) ).output ).toContain( `test-model; effort: low` )
        expect( ( await run( [ `invalid` ], endpoint ) ).code ).toBe( 1 )
        expect( calls.some( call => call.method.endsWith( `settings/update` ) ) ).toBe( false )
    } )
    it( `reads paginated model and loaded-thread catalogs`, async () => {
        const target = { model: `target`, defaultReasoningEffort: `high`, supportedReasoningEfforts: [ { reasoningEffort: `high` } ] }
        const { endpoint } = fixture( {
            'thread/loaded/list': params => params.cursor ? { data: [ `mine` ] } : { data: [ `other` ], nextCursor: `next` },
            'model/list': params => params.cursor ? { data: [ target ] } : { data: [], nextCursor: `next` },
        } )
        expect( ( await run( [ `target` ], endpoint ) ).code ).toBe( 0 )
    } )
    it( `does not join an unrelated thread`, async () => {
        const { endpoint, calls } = fixture()
        expect( ( await run( [ `target` ], endpoint, `other` ) ).code ).toBe( 1 )
        expect( calls.some( call => call.method === `thread/resume` ) ).toBe( false )
    } )
    it( `reports active-turn races and partial failures`, async () => {
        const raced = fixture( { 'turn/settings/update': { status: `targetUnavailable` } } )
        expect( ( await run( [ `target` ], raced.endpoint ) ).output ).toContain( `active turn ended` )
        const failed = fixture( { 'turn/settings/update': { error: { message: `feature disabled` } } } )
        const result = await run( [ `target` ], failed.endpoint )
        expect( result.code ).toBe( 1 )
        expect( result.output ).toContain( `Future turns now use target, but updating the active turn failed` )
    } )
} )
