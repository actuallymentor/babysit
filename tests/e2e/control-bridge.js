#!/usr/bin/env node
// Requires Docker and a Babysit image. Uses only an owned container/tmux server;
// copies existing credentials privately, never starts model inference, and cleans up.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { create_control_bridge } from '../../src/control/bridge.js'

const execute = promisify( execFile )
const run = async ( command, args, options = {} ) => ( await execute( command, args, {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024, ...options,
} ) ).stdout.trim()
const docker = args => run( `docker`, args )
const image = process.env.BABYSIT_CONTROL_E2E_IMAGE || `actuallymentor/babysit:latest`
const name = `babysit-control-e2e-${ process.pid }-${ randomUUID().slice( 0, 8 ) }`
const launch_id = randomUUID()
const temporary = mkdtempSync( join( tmpdir(), `babysit-control-e2e-` ) )
const socket = `control-e2e`
const project = `/tmp/control-project`
const assets = fileURLToPath( new URL( `../../src/docker/assets`, import.meta.url ) )
const credentials = [
    [ join( process.env.CLAUDE_CONFIG_DIR || join( homedir(), `.claude` ), `.credentials.json` ), `/home/node/.claude/.credentials.json` ],
    [ join( process.env.CODEX_HOME || join( homedir(), `.codex` ), `auth.json` ), `/home/node/.codex/auth.json` ],
    [ join( process.env.XDG_DATA_HOME || join( homedir(), `.local/share` ), `opencode/auth.json` ), `/home/node/.local/share/opencode/auth.json` ],
].filter( ( [ path ] ) => existsSync( path ) )
let container
let bridge
let ticker
let pane
const exec = args => docker( [ `exec`, `--user`, `node`, container, ...args ] )
const tmux = args => exec( [ `tmux`, `-L`, socket, ...args ] )
const capture = () => tmux( [ `capture-pane`, `-p`, `-t`, pane ] )
const keys = async ( target, ...values ) => {
    assert.equal( target, pane )
    await tmux( [ `send-keys`, `-t`, target, ...values ] )
    await delay( 120 )
}
const text = async ( target, value ) => {
    assert.equal( target, pane )
    await tmux( [ `set-buffer`, `-b`, `control`, `--`, value ] )
    await tmux( [ `paste-buffer`, `-p`, `-d`, `-b`, `control`, `-t`, target ] )
    await delay( 180 )
    await keys( target, `Enter` )
}
const until = async ( description, predicate, timeout_ms = 45000 ) => {
    const deadline = Date.now() + timeout_ms
    while( Date.now() < deadline ) {
        if( await predicate() ) return
        await delay( 200 )
    }
    throw new Error( `Timed out waiting for ${ description }` )
}
const helper = args => exec( [ `/usr/local/bin/babysit`, ...args ] )
const request_id = output => {
    const id = output.match( /Pending \w+ request \(([a-f0-9-]{36})\)/ )?.[1]
    assert.ok( id, `Expected a queued request, got: ${ output }` )
    return id
}
const applied = async ( operation, output ) => {
    if( !output.startsWith( `Pending ` ) ) return output
    const id = request_id( output )
    let result
    try {
        await until( `${ operation } bridge confirmation`, async () => {
            result = await helper( [ operation, `--status`, id ] )
            return !result.startsWith( `Pending ` )
        } )
    } catch ( error ) {
        throw new Error( `${ error.message }: ${ result }` )
    }
    return result
}

try {
    assert.ok( credentials.some( ( [ , path ] ) => path.includes( `.claude/` ) ), `Authenticated Claude Code credentials required` )
    container = await docker( [ `run`, `-d`, `--name`, name, `--user`, `root`,
        `--env`, `BABYSIT_CONTROL_ID=${ launch_id }`, `--env`, `BABYSIT_CONTROL_AGENT=claude`,
        `--entrypoint`, `sleep`, image, `infinity`,
    ] )
    await docker( [ `exec`, container, `mkdir`, `-p`, project, `/home/node/.claude`, `/home/node/.codex`, `/home/node/.local/share/opencode` ] )
    await docker( [ `exec`, container, `chown`, `node:node`, project, `/home/node/.claude`, `/home/node/.codex`, `/home/node/.local/share/opencode` ] )
    // The image may predate this checkout; test the actual current helpers.
    await docker( [ `cp`, `${ join( assets, `effort` ) }/.`, `${ container }:/opt/babysit-effort` ] )
    await docker( [ `cp`, `${ join( assets, `usage` ) }/.`, `${ container }:/opt/usage` ] )
    await docker( [ `exec`, container, `ln`, `-sfn`, `/opt/babysit-effort`, `/opt/effort` ] )
    await docker( [ `exec`, container, `chmod`, `+x`, `/opt/babysit-effort/bin.mjs` ] )
    for( const [ source, target ] of credentials ) {
        await docker( [ `cp`, source, `${ container }:${ target }` ] )
        await docker( [ `exec`, container, `chown`, `node:node`, target ] )
        await docker( [ `exec`, container, `chmod`, `600`, target ] )
    }
    const report_text = await helper( [ `usage`, `--json` ] )
    const report = JSON.parse( report_text )
    const sensitive_values = value => typeof value === `object` && value !== null
        ? Object.entries( value ).flatMap( ( [ key, item ] ) => /^(accessToken|refreshToken|access_token|refresh_token|id_token|key)$/.test( key ) && typeof item === `string` ? [ item ] : sensitive_values( item ) )
        : []
    credentials.flatMap( ( [ source ] ) => sensitive_values( JSON.parse( readFileSync( source, `utf8` ) ) ) ).forEach( secret => {
        assert.ok( !secret || !report_text.includes( secret ), `Usage output leaked a credential` )
    } )
    assert.equal( report.agents.find( result => result.agent === `claude` ).status, `ok` )
    console.log( `PASS container usage: ${ report.agents.map( result => `${ result.agent }=${ result.status }` ).join( `, ` ) }; no credentials in output` )

    writeFileSync( join( temporary, `claude.json` ), JSON.stringify( {
        hasCompletedOnboarding: true, lastOnboardingVersion: `9999.0.0`, theme: `dark`, bypassPermissionsModeAccepted: true,
        projects: { [ project ]: { hasTrustDialogAccepted: true } },
    } ), { mode: 0o600 } )
    writeFileSync( join( temporary, `settings.json` ), JSON.stringify( { skipDangerousModePermissionPrompt: true } ), { mode: 0o600 } )
    for( const [ source, target ] of [ [ `claude.json`, `/home/node/.claude.json` ], [ `settings.json`, `/home/node/.claude/settings.json` ] ] ) {
        await docker( [ `cp`, join( temporary, source ), `${ container }:${ target }` ] )
        await docker( [ `exec`, container, `chown`, `node:node`, target ] )
    }
    pane = await tmux( [ `new-session`, `-d`, `-P`, `-F`, `#{pane_id}`, `-s`, `native`, `-x`, `160`, `-y`, `50`, `-c`, project,
        `/home/node/.local/bin/claude --dangerously-skip-permissions --model sonnet`,
    ] )
    await until( `Claude idle composer`, async () => /^❯[ \u00a0]*(?:Try ".*)?$/m.test( await capture() ) )
    bridge = create_control_bridge( { control_id: launch_id, pane_id: pane, container_id: container, agent: `claude` }, { capture, text, keys } )
    assert.ok( bridge )
    ticker = setInterval( () => bridge.tick(), 150 )

    // A person's unsent draft must survive. Only this test's own draft is cleared.
    const draft = `UNSENT_CONTROL_E2E_DRAFT`
    await keys( pane, `-l`, draft )
    const pending = await helper( [ `effort`, `low` ] )
    const id = request_id( pending )
    assert.ok( ( await capture() ).includes( draft ) )
    await delay( 2500 )
    let deferred
    await until( `draft safety rejection`, async () => {
        deferred = await helper( [ `effort`, `--status`, id ] )
        return deferred.includes( `draft` )
    } )
    assert.ok( deferred.startsWith( `Pending ` ) )
    assert.ok( ( await capture() ).includes( draft ) )
    await keys( pane, `C-u` )
    const result = await applied( `effort`, pending )
    assert.match( result, /effort.*low.*session/i )
    console.log( `PASS helper -> Docker store -> monitor bridge -> native effort; draft preserved, queued status confirmed` )

    const models = await applied( `model`, await helper( [ `model` ] ) )
    assert.match( models, /Sonnet/i )
    assert.ok( !( await capture() ).includes( `Select model` ), `Model listing left its owned picker open` )
    console.log( `PASS container model listing traversed native Claude picker and closed its dialog` )
} catch ( error ) {
    if( pane ) console.error( ( await capture().catch( () => `` ) ).replace( /[\w.+-]+@[\w.-]+/g, `[account]` ) )
    throw error
} finally {
    clearInterval( ticker )
    await bridge?.close()
    if( container ) {
        await tmux( [ `kill-server` ] ).catch( () => {} )
        await docker( [ `stop`, `--time`, `1`, container ] ).catch( () => {} )
        await docker( [ `rm`, container ] ).catch( () => {} )
    }
    rmSync( temporary, { recursive: true, force: true } )
}
