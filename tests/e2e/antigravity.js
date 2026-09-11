#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { antigravity } from '../../src/agents/antigravity.js'
import { COMPLETION_HELPER_SOURCE, COMPLETION_HELPER_PATH, add_completion_hooks } from '../../src/agents/completion_capture.js'
import { CHECK_TRANSCRIPT } from '../../src/sessions/transcript.js'
import { is_initial_prompt_ready } from '../../src/cli/start.js'
import { agent_activity } from '../../src/babysit/activity.js'

// Exercise the real native TUI, hooks and SQLite storage without credentials or
// paid inference. The HTTP fixture replaces only Gemini's model responses.
const root = mkdtempSync( join( tmpdir(), `babysit-antigravity-e2e-` ) )
const home = join( root, `home` )
const workspace = join( root, `workspace` )
const native = join( home, `.gemini`, `antigravity-cli` )
const config = join( home, `.gemini`, `config` )
const helper = join( root, `capture.py` )
const completion_file = join( root, `completion`, `message.json` )
const socket = `babysit-antigravity-e2e-${ process.pid }`
const session = `contract`
const binary = process.env.AGY_E2E_BINARY ? resolve( process.env.AGY_E2E_BINARY ) : `agy`
const model = process.env.AGY_E2E_MODEL || `gemini-3.8-flash-medium`
const exec_file = promisify( execFile )
const run = async ( command, args, options = {} ) => ( await exec_file( command, args, {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
} ) ).stdout
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const capture = () => tmux( [ `capture-pane`, `-p`, `-t`, session ] )
const until = async ( description, predicate ) => {
    const deadline = Date.now() + 20_000
    while( Date.now() < deadline ) {
        if( await predicate() ) return
        await delay( 100 )
    }
    throw new Error( `Timed out waiting for ${ description }\n${ await capture().catch( () => `` ) }` )
}
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
    const help = await exec_file( binary, [ `--help` ], { timeout: 10_000 } ).catch( error => {
        throw new Error( `Real Antigravity CLI required: set AGY_E2E_BINARY to an installed agy binary. ${ error.message }` )
    } )
    assert.match( help.stdout + help.stderr, /--conversation/ )
    await run( `tmux`, [ `-V` ] )
    await run( `python3`, [ `--version` ] )
    for( const directory of [ workspace, config, join( native, `cache` ) ] ) mkdirSync( directory, { recursive: true } )
    writeFileSync( helper, COMPLETION_HELPER_SOURCE )
    writeFileSync( join( native, `settings.json` ), JSON.stringify( { modelProvider: `gemini` } ) )
    // Synthetic fixture state only: never accept terms or change user consent.
    writeFileSync( join( native, `cache`, `onboarding.json` ), JSON.stringify( {
        consumerOnboardingComplete: true, enterpriseOnboardingComplete: true, onboardingComplete: true,
    } ) )
    const hooks = JSON.stringify( add_completion_hooks( {}, `antigravity` ) ).replaceAll( COMPLETION_HELPER_PATH, helper )
    writeFileSync( join( config, `hooks.json` ), hooks )

    server = createServer( async ( request, response ) => {
        try {
            const chunks = []
            for await ( const chunk of request ) chunks.push( chunk )
            const payload = JSON.parse( Buffer.concat( chunks ).toString() )
            const request_text = ( payload.contents || [] ).flatMap( message => message.parts || [] ).map( part => part.text || `` ).join( `\n` )
            const answer = request_text.includes( `SECOND_NATIVE_TURN` ) ? `Native resumed answer.` : `Native first answer.`
            model_requests.push( request_text )
            response.writeHead( 200, { 'Content-Type': `text/event-stream` } )
            response.end( `data: ${ JSON.stringify( {
                candidates: [ { content: { role: `model`, parts: [ { text: answer } ] }, finishReason: `STOP` } ],
                usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
            } ) }\n\n` )
        } catch ( error ) {
            response.writeHead( 500 )
            response.end( error.message )
        }
    } )
    await new Promise( listen => server.listen( 0, `127.0.0.1`, listen ) )
    const env = {
        ...process.env,
        HOME: home,
        GEMINI_API_KEY: `synthetic-local-test-key`,
        GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${ server.address().port }`,
        AGY_CLI_DISABLE_AUTO_UPDATE: `1`,
        BABYSIT_COMPLETION_FILE: completion_file,
        BABYSIT_COMPLETION_LAUNCH_ID: `11111111-1111-1111-1111-111111111111`,
    }
    delete env.BABYSIT_RECOVERY_IDENTITY
    const launch = async extra => {
        // Multiple tmux arguments bypass shell interpolation entirely.
        await run( `tmux`, [ `-L`, socket, `new-session`, `-d`, `-s`, session, `-x`, `110`, `-y`, `35`,
            `python3`, helper, `launch`, `antigravity`, binary, antigravity.flags.skip_permissions(),
            ...antigravity.flags.model( model ), ...extra,
        ], { env, cwd: workspace } )
    }
    const submit = async prompt => {
        await tmux( [ `send-keys`, `-l`, `-t`, session, prompt ] )
        await tmux( [ `send-keys`, `-t`, session, `Enter` ] )
    }

    const before_missing_resume = model_requests.length
    const missing_resume = await run( `python3`, [ helper, `launch`, `antigravity`, binary,
        ...antigravity.flags.resume( `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` ), `--print`, `DO_NOT_RUN`,
        ...antigravity.flags.model( model ),
    ], { env, cwd: workspace } ).then( () => null, error => error )
    assert.equal( missing_resume?.code, 1 )
    assert.match( missing_resume.stderr, /exact native conversation is unavailable/ )
    assert.equal( model_requests.length, before_missing_resume, `Missing native resume must never send a model request` )
    console.log( `PASS missing exact resume fails before native fallback or model requests` )

    await launch( [] )
    await until( `first workspace trust prompt`, async () => ( await capture() ).includes( `Do you trust the contents of this project?` ) )
    assert.equal( is_initial_prompt_ready( antigravity, await capture() ), false, `Never send the task into a trust prompt` )
    await tmux( [ `send-keys`, `-t`, session, `Enter` ] )
    await until( `native composer`, async () => is_initial_prompt_ready( antigravity, await capture() ) )
    assert.equal( agent_activity( await capture(), `antigravity` ), `idle` )
    console.log( `PASS real Antigravity trust prompt, composer readiness and idle activity` )

    await submit( `FIRST_NATIVE_TURN` )
    await until( `first native completion hook`, () => read_completion()?.text === `Native first answer.` )
    const first = read_completion()
    assert.equal( first.agent, `antigravity` )
    assert.match( first.session_id, /^[a-f0-9-]{36}$/ )
    await until( `rendered first reply`, async () => ( await capture() ).includes( `Native first answer.` ) )
    const probe = CHECK_TRANSCRIPT.replace( `pathlib.Path('/home/node')`, `pathlib.Path(${ JSON.stringify( home ) })` )
    await run( `python3`, [ `-c`, probe, `antigravity`, first.session_id ] )
    console.log( `PASS real native hooks publish visible reply and exact SQLite root identity` )

    await submit( `/exit` )
    await until( `native CLI exit`, async () => !await tmux( [ `has-session`, `-t`, session ] ).then( () => true, () => false ) )
    // Prove the persisted native CLI directory suffices when config is staged
    // afresh into a replacement container. Preserve only our generated hooks.
    rmSync( config, { recursive: true, force: true } )
    mkdirSync( config, { recursive: true } )
    writeFileSync( join( config, `hooks.json` ), hooks )
    await launch( antigravity.flags.resume( first.session_id ) )
    await until( `resumed composer or workspace trust`, async () => {
        const output = await capture()
        if( output.includes( `Do you trust the contents of this project?` ) ) {
            await tmux( [ `send-keys`, `-t`, session, `Enter` ] )
            return false
        }
        return is_initial_prompt_ready( antigravity, output )
    } )
    await submit( `SECOND_NATIVE_TURN` )
    await until( `resumed native completion hook`, () => read_completion()?.text === `Native resumed answer.` )
    const second = read_completion()
    assert.equal( second.session_id, first.session_id )
    assert.notEqual( second.turn_id, first.turn_id )
    assert.ok( model_requests.some( text => text.includes( `FIRST_NATIVE_TURN` ) && text.includes( `SECOND_NATIVE_TURN` ) ), `Resumed model context includes the first user turn` )
    await until( `rendered resumed reply`, async () => ( await capture() ).includes( `Native resumed answer.` ) )
    console.log( `PASS real --conversation resume retains UUID, native history and completion capture` )
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    if( server ) await new Promise( closed => server.close( closed ) )
    rmSync( root, { recursive: true, force: true } )
}
