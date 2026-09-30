#!/usr/bin/env node
// Real Claude controls, with production paste timing and unthrottled tmux keys.
// Synthetic credentials + a closed localhost endpoint prevent paid inference.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { terminal_control } from '../../src/control/terminal.js'
import { send_text } from '../../src/tmux/send.js'

const execute = promisify( execFile )
const run = async ( command, args ) => ( await execute( command, args, { timeout: 30_000 } ) ).stdout
const socket = `babysit-claude-controls-${ process.pid }`
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const root = mkdtempSync( join( tmpdir(), `babysit-claude-controls-` ) )
const config = join( root, `config` )
const project = join( root, `project` )
const pane = `controls`
const capture = () => tmux( [ `capture-pane`, `-p`, `-t`, pane ] )
const keys = ( ...values ) => tmux( [ `send-keys`, `-t`, pane, ...values ] )
// Only replace the socket; retain the production paste framing and 150ms delay.
const runner = ( command, args ) => run( command, [ `-L`, socket, ...args.slice( 2 ) ] )
const until = async predicate => {
    const deadline = Date.now() + 20_000
    while( Date.now() < deadline ) {
        if( await predicate() ) return
        await delay( 100 )
    }
    throw new Error( `Timed out waiting for Claude's composer` )
}
const control = ( operation, value ) => terminal_control( {
    agent: `claude`, operation, value, capture,
    capture_styled: () => tmux( [ `capture-pane`, `-e`, `-p`, `-t`, pane ] ),
    send_text: text => send_text( pane, text, { runner } ), send_keys: keys,
} )
const closed = async () => until( async () => {
    const screen = await capture()
    return !/^\s*(?:Select model|Effort)\s*$/m.test( screen ) && /^❯/m.test( screen )
} )

try {
    mkdirSync( config )
    mkdirSync( project )
    writeFileSync( join( config, `.claude.json` ), JSON.stringify( {
        hasCompletedOnboarding: true, lastOnboardingVersion: `9999.0.0`, theme: `dark`,
        bypassPermissionsModeAccepted: true,
        customApiKeyResponses: { approved: [ `controls-fixture` ], rejected: [] },
        projects: { [ project ]: { hasTrustDialogAccepted: true } },
    } ) )
    const settings = join( config, `settings.json` )
    writeFileSync( settings, JSON.stringify( { skipDangerousModePermissionPrompt: true } ) )
    await tmux( [ `new-session`, `-d`, `-s`, pane, `-x`, `160`, `-y`, `50`, `-c`, project,
        `env`, `CLAUDE_CONFIG_DIR=${ config }`, `ANTHROPIC_API_KEY=sk-ant-controls-fixture`,
        `ANTHROPIC_BASE_URL=http://127.0.0.1:1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
        `claude`, `--dangerously-skip-permissions`, `--model`, `opus`,
    ] )
    await until( async () => {
        const screen = await capture()
        if( /Do you want to use this API key\?/.test( screen ) ) {
            await keys( `Up` )
            await delay( 100 )
            await keys( `Enter` )
        }
        return /^❯[ \u00a0]*$/m.test( screen ) && /bypass permissions on/.test( screen )
    } )
    const initial_settings = readFileSync( settings, `utf8` )
    const initial_model = ( await capture() ).match( /Opus [\d.]+/ )?.[ 0 ]
    assert.ok( initial_model, `Claude did not identify its initial Opus model` )
    const versioned_alias = initial_model.toLowerCase().replace( ` `, `-` )
    const api_id = `claude-${ versioned_alias.replaceAll( `.`, `-` ) }`
    let expected_models
    for( const [ width, height ] of [ [ 40, 16 ], [ 160, 50 ], [ 80, 24 ], [ 60, 20 ] ] ) {
        await tmux( [ `resize-window`, `-t`, pane, `-x`, String( width ), `-y`, String( height ) ] )
        await delay( 150 )
        if( width === 40 ) {
            // At this size Claude clips the selected row and cancel footer.
            // A failed scan must release its picker before the next control.
            await assert.rejects( control( `model` ), /selected row|small|visible|fit|clipped/i )
            await closed()
            await tmux( [ `resize-window`, `-t`, pane, `-x`, `160`, `-y`, `50` ] )
            await delay( 150 )
            assert.ok( ( await capture() ).includes( `Kept model as ${ initial_model }` ), `Clipped listing changed the active model` )
            console.log( `PASS clipped model picker dismissed at ${ width }x${ height }; model unchanged` )
            continue
        }
        const listing = await control( `effort` )
        assert.ok( listing.supported.includes( `low` ) && listing.supported.includes( `high` ) )
        await closed()
        for( const level of listing.supported ) {
            assert.equal( ( await control( `effort`, level ) ).applied, level )
            await closed()
        }
        const models = await control( `model` )
        const ids = models.models.map( model => model.id ).filter( id => id !== `opus` ).sort()
        expected_models ||= ids
        assert.deepEqual( ids, expected_models, `Model catalog changed at ${ width }x${ height }` )
        // New CLI catalogs fold the separate 1M Opus row into the family row.
        const opus_id = ids.includes( `opus[1m]` ) ? `opus[1m]` : `opus`
        assert.ok( ids.includes( `sonnet` ) && models.models.some( model => model.id === opus_id ) )
        await closed()
        for( const id of [ `sonnet`, opus_id, versioned_alias, api_id ] ) {
            const switched = await control( `model`, id )
            assert.ok( switched.applied, `Failed to select emitted model ${ id }` )
            await closed()
            const screen = await capture()
            const latest = screen.slice( screen.lastIndexOf( `❯ /model` ) ).replace( /\s+/g, ` ` )
            assert.match( latest, /(?:Set model to|Kept model as)/ )
            assert.ok( latest.includes( id === `sonnet` ? `Sonnet` : initial_model ), `Native model readback differs from ${ id }` )
            // Repeated identical confirmations require a native picker
            // readback; Escape echoes "Kept model as" without a scope suffix.
            assert.ok( latest.includes( `this session only` ) || latest.includes( `Kept model as` ), `Model ${ id } was not session-only` )
            assert.equal( readFileSync( settings, `utf8` ), initial_settings, `Model ${ id } changed persisted settings` )
        }
        await closed()
        assert.deepEqual( ( await control( `effort` ) ).supported, listing.supported )
        await closed()
        assert.equal( ( await control( `effort`, `low` ) ).applied, `low` )
        await closed()
        console.log( `PASS native controls at ${ width }x${ height }` )
    }
    assert.equal( readFileSync( settings, `utf8` ), initial_settings, `Controls changed persisted settings` )
    console.log( `PASS real Claude ${ ( await run( `claude`, [ `--version` ] ) ).trim() }: effort listing, all levels, model listing and switching, repeated effort; settings unchanged` )
} catch ( error ) {
    console.error( await capture().catch( () => `` ) )
    throw error
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    rmSync( root, { recursive: true, force: true } )
}
