import { afterEach, describe, expect, it } from 'bun:test'
import { serve } from 'bun'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observe_completions } from '../src/docker/assets/effort/codex-completion.mjs'

const cleanups = []
afterEach( async () => {
    for( const cleanup of cleanups.splice( 0 ).reverse() ) await cleanup()
} )

const until = async condition => {
    const deadline = Date.now() + 2_000
    while( !condition() ) {
        if( Date.now() > deadline ) throw new Error( `Timed out waiting for observer` )
        await new Promise( resolve => setTimeout( resolve, 10 ) )
    }
}

const message = ( text, phase = `final_answer`, extra = {} ) => ( { type: `agentMessage`, id: text, text, phase, ...extra } )
const completed = ( id, items, extra = {} ) => ( { id, status: `completed`, itemsView: `full`, items, ...extra } )

const fixture = async ( { loaded = [], turn = completed( `latest`, [ message( `answer` ) ] ), item_pages, notify, delay_ms = 0 } = {} ) => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-completion-observer-` ) )
    cleanups.push( () => rmSync( directory, { recursive: true, force: true } ) )
    const output = join( directory, `invocations.jsonl` )
    writeFileSync( join( directory, `python3` ), `#!/usr/bin/env node\nif(process.argv[3]==='notify-command')process.stdout.write(process.env.CAPTURE_TEST_NOTIFY);else setTimeout(()=>require('node:fs').appendFileSync(process.env.CAPTURE_TEST_OUTPUT, JSON.stringify({argv:process.argv.slice(2),root:process.env.BABYSIT_COMPLETION_ROOT_PID,agent:process.env.BABYSIT_EFFORT_AGENT})+'\\n'),${ delay_ms })\n`, { mode: 0o755 } )
    const calls = []
    let socket
    const server = serve( {
        hostname: `127.0.0.1`, port: 0,
        fetch( request, server ) {
            if( !server.upgrade( request ) ) return new Response( `upgrade required`, { status: 400 } )
        },
        websocket: {
            open( client ) {
                socket = client
            },
            message( client, raw ) {
                const request = JSON.parse( raw )
                if( request.id === undefined ) return
                calls.push( request )
                const replies = {
                    initialize: {},
                    'config/read': { config: { notify: notify || [ `python3`, `/home/node/.babysit-capture/capture.py`, `codex`, `["previous-hook"]` ] } },
                    'thread/loaded/list': { data: loaded },
                    'thread/read': { thread: { id: request.params?.threadId, source: `vscode`, cwd: `/test/project`, parentThreadId: request.params?.threadId === `child` ? `root` : null } },
                    'thread/resume': {},
                    'thread/turns/list': { data: [ turn ] },
                    'thread/items/list': item_pages?.[ request.params?.cursor || `first` ] || { data: [] },
                }
                client.send( JSON.stringify( { id: request.id, result: replies[ request.method ] } ) )
            },
        },
    } )
    cleanups.push( () => server.stop( true ) )
    const observer = await observe_completions( `ws://127.0.0.1:${ server.port }`, { env: { ...process.env, PATH: `${ directory }:${ process.env.PATH }`, CAPTURE_TEST_OUTPUT: output, CAPTURE_TEST_NOTIFY: JSON.stringify( notify ?? [ `previous-hook` ] ), BABYSIT_EFFORT_AGENT: `codex` } } )
    cleanups.push( () => observer.close() )
    const emit = ( method, params ) => socket.send( JSON.stringify( { method, params } ) )
    const status = ( type, threadId = `root` ) => emit( `thread/status/changed`, { threadId, status: { type } } )
    const records = () => existsSync( output ) ? readFileSync( output, `utf8` ).trim().split( `\n` ).filter( Boolean ).map( line => JSON.parse( line ) ) : []
    return { emit, status, calls, records, observer }
}

describe( `Codex app-server completion bridge`, () => {

    it( `lets a slow notification finish while the observer shuts down`, async () => {
        const test = await fixture( { delay_ms: 5_200 } )
        test.emit( `turn/completed`, { threadId: `root`, turn: completed( `slow`, [ message( `final` ) ] ) } )
        await until( () => test.calls.some( call => call.method === `thread/read` ) )
        await test.observer.close()
        expect( test.records() ).toHaveLength( 1 )
    }, 15_000 )

    it( `captures the final answer once and invokes the existing notify chain with root identity`, async () => {
        const turn = completed( `turn1`, [ message( `progress`, `commentary` ), message( `final answer` ), message( `background`, `final_answer`, { delivery: `async` } ) ] )
        const test = await fixture( { turn } )
        test.status( `active` )
        test.emit( `turn/completed`, { threadId: `root`, turn } )
        test.status( `idle` )
        await until( () => test.records().length === 1 && test.calls.some( call => call.method === `thread/turns/list` ) )
        await test.observer.close()
        expect( test.records() ).toHaveLength( 1 )
        const [ record ] = test.records()
        expect( record.argv.slice( 0, 3 ) ).toEqual( [ `/home/node/.babysit-capture/capture.py`, `codex`, `["previous-hook"]` ] )
        expect( JSON.parse( record.argv[ 3 ] ) ).toEqual( { type: `agent-turn-complete`, 'thread-id': `root`, 'turn-id': `turn1`, cwd: `/test/project`, 'last-assistant-message': `final answer` } )
        expect( record.root ).toBe( String( process.pid ) )
        expect( record.agent ).toBe( `codex` )
    } )

    it( `captures a short turn from global idle even when no turn event arrived`, async () => {
        const test = await fixture()
        test.status( `active` )
        test.status( `idle` )
        await until( () => test.records().length === 1 )
        expect( JSON.parse( test.records()[ 0 ].argv[ 3 ] )[ `last-assistant-message` ] ).toBe( `answer` )
        expect( test.calls.filter( call => call.method === `thread/resume` ) ).toHaveLength( 1 )
    } )

    it( `does not republish historical idle turns or capture subagents`, async () => {
        const test = await fixture( { loaded: [ `root`, `child` ] } )
        test.status( `idle` )
        test.status( `active`, `child` )
        test.emit( `turn/completed`, { threadId: `child`, turn: completed( `child-turn`, [ message( `private child` ) ] ) } )
        test.status( `idle`, `child` )
        // A later root status gives a deterministic barrier for the queued notifications.
        test.status( `active` )
        await until( () => test.calls.some( call => call.method === `thread/read` && call.params.threadId === `child` ) )
        await new Promise( resolve => setTimeout( resolve, 20 ) )
        await test.observer.close()
        expect( test.records() ).toEqual( [] )
        expect( test.calls.filter( call => call.method === `thread/resume` ).map( call => call.params.threadId ) ).toEqual( [ `root` ] )
    } )

    it( `loads every item page when completion items are summaries and supports phase-unknown legacy answers`, async () => {
        const turn = completed( `paged`, [], { itemsView: `summary` } )
        const test = await fixture( { turn, item_pages: {
            first: { data: [ { turnId: `paged`, item: message( `progress`, `commentary` ) } ], nextCursor: `second` },
            second: { data: [ { turnId: `other`, item: message( `wrong turn` ) }, { turnId: `paged`, item: message( `legacy final`, null ) } ] },
        } } )
        test.emit( `turn/completed`, { threadId: `root`, turn } )
        await until( () => test.records().length === 1 )
        expect( JSON.parse( test.records()[ 0 ].argv[ 3 ] )[ `last-assistant-message` ] ).toBe( `legacy final` )
        expect( test.calls.filter( call => call.method === `thread/items/list` ).map( call => call.params.cursor ) ).toEqual( [ undefined, `second` ] )
    } )

    it( `does not forward interrupted, failed, or commentary-only turns`, async () => {
        const test = await fixture()
        for( const status of [ `interrupted`, `failed`, `completed` ] ) test.emit( `turn/completed`, { threadId: `root`, turn: completed( status, [ message( `progress`, `commentary` ) ], { status } ) } )
        await until( () => test.calls.some( call => call.method === `thread/read` ) )
        await test.observer.close()
        expect( test.records() ).toEqual( [] )
    } )

    it( `rejects an invalid callback instead of silently pretending to observe`, async () => {
        await expect( fixture( { notify: { invalid: true } } ) ).rejects.toThrow( `must be a command array` )
    } )

} )
