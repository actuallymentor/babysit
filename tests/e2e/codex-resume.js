#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { COMPLETION_HELPER_SOURCE, COMPLETION_HELPER_PATH } from '../../src/agents/completion_capture.js'

// The real CLI, remote frontend and persisted rollout exercise Codex's argument
// validation and permission handling. Only model inference is a local fixture.
const root = mkdtempSync( join( tmpdir(), `babysit-codex-resume-e2e-` ) )
const home = join( root, `home` )
const codex_home = join( home, `.codex` )
const workspace = join( root, `workspace` )
const socket = `babysit-codex-resume-e2e-${ process.pid }`
const session = `contract`
const binary = process.env.CODEX_E2E_BINARY ? resolve( process.env.CODEX_E2E_BINARY ) : `codex`
const effort = join( root, `effort` )
const launcher = join( effort, `launch.mjs` )
const helper = join( root, `capture.py` )
const completion_file = join( root, `completion`, `message.json` )
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
const read_completion = () => {
    try {
        return JSON.parse( readFileSync( completion_file, `utf8` ) )
    } catch {
        return null
    }
}
const model_requests = []
let server

try {
    await run( binary, [ `--version` ] ).catch( error => {
        throw new Error( `Real Codex CLI required: set CODEX_E2E_BINARY to an installed codex binary. ${ error.message }` )
    } )
    await run( `tmux`, [ `-V` ] )
    for( const directory of [ workspace, codex_home ] ) mkdirSync( directory, { recursive: true } )
    writeFileSync( helper, COMPLETION_HELPER_SOURCE )
    // Remap only the container's fixed capture path into isolated test storage.
    // Both the native notify chain and the managed observer use the real helper.
    cpSync( fileURLToPath( new URL( `../../src/docker/assets/effort`, import.meta.url ) ), effort, { recursive: true } )
    for( const file of [ `launch.mjs`, `codex-completion.mjs` ] ) {
        const path = join( effort, file )
        writeFileSync( path, readFileSync( path, `utf8` ).replaceAll( COMPLETION_HELPER_PATH, helper ) )
    }
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
    const env = {
        ...process.env, HOME: home, CODEX_HOME: codex_home, TERM: `xterm-256color`,
        BABYSIT_COMPLETION_FILE: completion_file,
        BABYSIT_COMPLETION_LAUNCH_ID: `11111111-1111-1111-1111-111111111111`,
    }
    delete env.BABYSIT_RECOVERY_IDENTITY
    delete env.OPENAI_API_KEY
    delete env.OPENAI_BASE_URL
    const launch = args => run( `tmux`, [ `-L`, socket, `new-session`, `-d`, `-s`, session, `-x`, `110`, `-y`, `35`,
        process.execPath, launcher, `python3`, helper, `launch`, `codex`, binary, ...args,
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
    let previous_turn
    for( const [ index, mode ] of [ `normal`, `normal`, `yolo` ].entries() ) {
        const flags = mode === `yolo` ? [ `--dangerously-bypass-approvals-and-sandbox` ] : [ `--sandbox`, `danger-full-access`, `--ask-for-approval`, `on-request` ]
        await launch( [ ...flags, ...thread_id ? [ `resume`, thread_id ] : [] ] )
        await until( `${ mode } composer`, async () => ( await capture() ).includes( `› Ask Codex to do anything` ) )
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
        await until( `${ mode } completion capture`, () => read_completion()?.text === `Native completed turn ${ index + 1 }.` )
        const completion = read_completion()
        assert.equal( completion.agent, `codex` )
        assert.equal( completion.session_id, thread_id )
        assert.equal( completion.launch_id, env.BABYSIT_COMPLETION_LAUNCH_ID )
        assert.notEqual( completion.turn_id, previous_turn )
        previous_turn = completion.turn_id
        console.log( `PASS real Codex launcher ${ index ? `resume` : `start` } (${ mode }): completed turn, exact thread, effective permissions and completion capture` )
        await stop()
    }
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    if( server ) await new Promise( closed => server.close( closed ) )
    rmSync( root, { recursive: true, force: true } )
}
