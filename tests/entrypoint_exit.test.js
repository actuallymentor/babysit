import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { COMPLETION_HELPER_SOURCE } from '../src/agents/completion_capture.js'

const cleanups = []
afterEach( () => cleanups.splice( 0 ).reverse().forEach( cleanup => cleanup() ) )

const run_supervisor = async ( { interrupt = false, status = 0 } = {} ) => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-native-exit-` ) )
    cleanups.push( () => rmSync( directory, { recursive: true, force: true } ) )
    const helper = join( directory, `capture.py` )
    const state = join( directory, `state` )
    const receipt = join( state, `.babysit-identities`, `test-launch.exit.json` )
    const agent = join( directory, `agent.cjs` )
    const ready = join( directory, `ready` )
    mkdirSync( state )
    writeFileSync( helper, COMPLETION_HELPER_SOURCE.replace( `'/home/node/.claude/projects'`, JSON.stringify( state ) ) )
    writeFileSync( agent, interrupt
        ? `process.on('SIGTERM',()=>process.exit(0));require('fs').writeFileSync(${ JSON.stringify( ready ) },'ready');setInterval(()=>{},1000)`
        : `process.exit(${ status })` )
    const source = readFileSync( new URL( `../src/docker/assets/entrypoint.sh`, import.meta.url ), `utf8` )
    // Run the actual supervision section. UID/bootstrap setup belongs to the
    // Docker E2E; these stand-ins leave signal forwarding and receipt order real.
    const script = `set -e\nrun_agent() { exec "$@"; }\ngosu() { shift; "$@"; }\n${ source.slice( source.indexOf( `# Preserve the frontend` ) ).replaceAll( `/home/node/.babysit-capture/capture.py`, helper ) }`
    const child = spawn( `bash`, [ `-c`, script, `entrypoint`, `python3`, helper, `launch`, `claude`, `node`, agent ], {
        env: { ...process.env, BABYSIT_RECOVERY_IDENTITY: `1`, BABYSIT_COMPLETION_LAUNCH_ID: `test-launch`, BABYSIT_EXIT_SENTINEL: `sentinel` },
        stdio: [ `ignore`, `pipe`, `pipe` ],
    } )
    cleanups.push( () => child.kill( `SIGKILL` ) )
    let output = ``
    let errors = ``
    let receipt_before_marker = false
    child.stdout.on( `data`, data => {
        output += data
        if( output.includes( `__BABYSIT_AGENT_EXIT__` ) ) receipt_before_marker = existsSync( receipt )
    } )
    child.stderr.on( `data`, data => { errors += data } )
    const done = new Promise( resolve => child.once( `close`, code => resolve( code ) ) )
    if( interrupt ) {
        const deadline = Date.now() + 5_000
        while( !existsSync( ready ) ) {
            if( Date.now() > deadline ) throw new Error( `Native child did not become ready` )
            await new Promise( resolve => setTimeout( resolve, 10 ) )
        }
        child.kill( `SIGTERM` )
    }
    const code = await done
    expect( errors ).toBe( `` )
    expect( receipt_before_marker ).toBe( true )
    return { code, output, record: JSON.parse( readFileSync( receipt, `utf8` ) ) }
}

describe( `durable native exits`, () => {

    it( `persists a clean native exit before the terminal marker disappears`, async () => {
        const { code, record, output } = await run_supervisor()
        expect( code ).toBe( 0 )
        expect( record ).toMatchObject( { version: 1, launch_id: `test-launch`, agent: `claude`, exit_status: 0, interrupted: false } )
        expect( output ).toContain( `__BABYSIT_AGENT_EXIT__:sentinel:0` )
    } )

    it( `records interruption even when the native SIGTERM handler returns zero`, async () => {
        const { code, record, output } = await run_supervisor( { interrupt: true } )
        expect( code ).toBe( 0 )
        expect( record.exit_status ).toBe( 0 )
        expect( record.interrupted ).toBe( true )
        expect( output ).toContain( `__BABYSIT_AGENT_EXIT__:sentinel:143` )
    } )

    it( `preserves native failure status instead of marking a failed CLI clean`, async () => {
        const { code, record } = await run_supervisor( { status: 7 } )
        expect( code ).toBe( 7 )
        expect( record.exit_status ).toBe( 7 )
        expect( record.interrupted ).toBe( false )
    } )

} )
