#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

// The real CLI, remote frontend and persisted rollout exercise Codex's argument
// validation and permission handling. Only model inference is a local fixture.
const root = mkdtempSync( join( tmpdir(), `babysit-codex-resume-e2e-` ) )
const home = join( root, `home` )
const codex_home = join( home, `.codex` )
const workspace = join( root, `workspace` )
const socket = `babysit-codex-resume-e2e-${ process.pid }`
const session = `contract`
const binary = process.env.CODEX_E2E_BINARY ? resolve( process.env.CODEX_E2E_BINARY ) : `codex`
const launcher = fileURLToPath( new URL( `../../src/docker/assets/effort/launch.mjs`, import.meta.url ) )
const exec_file = promisify( execFile )
const run = async ( command, args, options = {} ) => ( await exec_file( command, args, {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
} ) ).stdout
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const capture = () => tmux( [ `capture-pane`, `-p`, `-t`, session ] )
const until = async ( description, predicate ) => {
    const deadline = Date.now() + 30_000
    while( Date.now() < deadline ) {
        if( await predicate() ) return
        await delay( 100 )
    }
    throw new Error( `Timed out waiting for ${ description }\n${ await capture().catch( () => `` ) }` )
}
const rollouts = () => {
    try {
        return readdirSync( join( codex_home, `sessions` ), { recursive: true } ).filter( name => name.endsWith( `.jsonl` ) )
    } catch {
        return []
    }
}
const records = () => rollouts().flatMap( name => readFileSync( join( codex_home, `sessions`, name ), `utf8` ).trim().split( `\n` ).filter( Boolean ).map( line => JSON.parse( line ) ) )
const model_requests = []
let server

try {
    await run( binary, [ `--version` ] ).catch( error => {
        throw new Error( `Real Codex CLI required: set CODEX_E2E_BINARY to an installed codex binary. ${ error.message }` )
    } )
    await run( `tmux`, [ `-V` ] )
    for( const directory of [ workspace, codex_home ] ) mkdirSync( directory, { recursive: true } )
    server = createServer( async ( request, response ) => {
        try {
            const chunks = []
            for await ( const chunk of request ) chunks.push( chunk )
            const payload = JSON.parse( Buffer.concat( chunks ).toString() )
            model_requests.push( payload )
            const turn = Math.max( 0, ...[ ...JSON.stringify( payload ).matchAll( /NATIVE_TURN_(\d+)/g ) ].map( match => Number( match[ 1 ] ) ) )
            const answer = `Native completed turn ${ turn }.`
            const item = { id: `msg_${ model_requests.length }`, type: `message`, role: `assistant`, status: `completed`, content: [ { type: `output_text`, text: answer, annotations: [] } ] }
            const result = { id: `resp_${ model_requests.length }`, object: `response`, status: `completed`, output: [ item ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } }
            response.writeHead( 200, { 'Content-Type': `text/event-stream` } )
            for( const event of [
                { type: `response.created`, response: { ...result, status: `in_progress`, output: [] } },
                { type: `response.output_item.added`, output_index: 0, item: { ...item, status: `in_progress`, content: [] } },
                { type: `response.output_text.delta`, item_id: item.id, output_index: 0, content_index: 0, delta: answer },
                { type: `response.output_item.done`, output_index: 0, item },
                { type: `response.completed`, response: result },
            ] ) response.write( `event: ${ event.type }\ndata: ${ JSON.stringify( event ) }\n\n` )
            response.end()
        } catch ( error ) {
            response.writeHead( 500 )
            response.end( error.message )
        }
    } )
    await new Promise( listen => server.listen( 0, `127.0.0.1`, listen ) )
    writeFileSync( join( codex_home, `config.toml` ), `
model = "gpt-5.6"
model_provider = "fixture"
check_for_update_on_startup = false
[model_providers.fixture]
name = "Local fixture"
base_url = "http://127.0.0.1:${ server.address().port }/v1"
wire_api = "responses"
requires_openai_auth = false
[projects.${ JSON.stringify( workspace ) }]
trust_level = "trusted"
` )
    const env = { ...process.env, HOME: home, CODEX_HOME: codex_home, TERM: `xterm-256color` }
    delete env.OPENAI_API_KEY
    delete env.OPENAI_BASE_URL
    const launch = args => run( `tmux`, [ `-L`, socket, `new-session`, `-d`, `-s`, session, `-x`, `110`, `-y`, `35`,
        process.execPath, launcher, binary, ...args,
    ], { env, cwd: workspace } )
    const submit = async prompt => {
        await tmux( [ `send-keys`, `-l`, `-t`, session, prompt ] )
        await delay( 200 )
        await tmux( [ `send-keys`, `-t`, session, `Enter` ] )
    }
    const stop = async () => {
        await submit( `/exit` )
        await until( `native CLI exit`, async () => !await tmux( [ `has-session`, `-t`, session ] ).then( () => true, () => false ) )
    }
    let thread_id
    for( const [ index, mode ] of [ `normal`, `normal`, `yolo` ].entries() ) {
        const flags = mode === `yolo` ? [ `--dangerously-bypass-approvals-and-sandbox` ] : [ `--sandbox`, `danger-full-access`, `--ask-for-approval`, `on-request` ]
        await launch( [ ...flags, ...thread_id ? [ `resume`, thread_id ] : [] ] )
        await until( `${ mode } composer`, async () => ( await capture() ).includes( `›` ) )
        await submit( `NATIVE_TURN_${ index + 1 }` )
        await until( `${ mode } completed turn`, () => records().filter( record => record.type === `event_msg` && record.payload.type === `task_complete` ).length === index + 1 )
        const persisted = records()
        const ids = new Set( persisted.filter( record => record.type === `session_meta` ).map( record => record.payload.id ) )
        assert.equal( ids.size, 1, `Resume must retain the exact native thread` )
        thread_id ||= [ ...ids ][ 0 ]
        assert.equal( [ ...ids ][ 0 ], thread_id )
        const context = persisted.filter( record => record.type === `turn_context` ).at( -1 ).payload
        assert.equal( context.approval_policy, mode === `yolo` ? `never` : `on-request` )
        assert.equal( context.sandbox_policy.type, `danger-full-access` )
        await until( `rendered completed reply`, async () => ( await capture() ).includes( `Native completed turn ${ index + 1 }.` ) )
        assert.ok( model_requests.some( request => JSON.stringify( request ).includes( `NATIVE_TURN_1` ) && JSON.stringify( request ).includes( `NATIVE_TURN_${ index + 1 }` ) ), `Resumed model context includes the original turn` )
        console.log( `PASS real Codex launcher ${ index ? `resume` : `start` } (${ mode }): completed turn, exact thread and effective permissions` )
        await stop()
    }
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    if( server ) await new Promise( closed => server.close( closed ) )
    rmSync( root, { recursive: true, force: true } )
}
