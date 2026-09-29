#!/usr/bin/env node
// Drift detector for Claude's bypass-immune "Dangerous rm operation" prompt,
// which Babysit's YOLO monitor answers (src/agents/claude.js).
//
// 1. Static contract: the installed Claude binary still carries the strings
//    and bypass-immune flag the approver relies on.
// 2. Live contract: a real `claude --dangerously-skip-permissions` pane is
//    asked to run a guarded rm. The dialog is matched line by line; then the
//    real Babysit monitor approves it and the removal must actually happen.
//
// Any drift prints a report with the Claude version, what no longer matches,
// and the captured screen, so the matcher and fixtures can be updated.
//
// Requires an authenticated host Claude Code and makes one small model call
// (default haiku; override with BABYSIT_DIALOG_E2E_MODEL). The only files it
// deletes are inside its own temp directory. Claude records that directory
// as trusted in ~/.claude.json.
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { DANGEROUS_DIALOG, claude, find_dangerous_command_dialog } from '../../src/agents/claude.js'
import { start_monitor } from '../../src/babysit/monitor.js'
import { check_claude_binary, find_claude_binary } from './assets/claude-dialog-contract.js'

const exec_file = promisify( execFile )
const run = async ( command, args, options = {} ) => ( await exec_file( command, args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, ...options } ) ).stdout.trim()
const socket = `babysit-dialog-e2e-${ process.pid }`
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const root = mkdtempSync( join( tmpdir(), `babysit-dialog-e2e-` ) )
const victim = join( root, `victim` )
const model = process.env.BABYSIT_DIALOG_E2E_MODEL || `haiku`
const pane = `dialog`
const capture = () => tmux( [ `capture-pane`, `-p`, `-t`, pane ] )
const bottom = screen => screen.split( `\n` ).filter( line => line.trim() ).slice( -25 ).join( `\n` )
const redact = text => text.replace( /[\w.+-]+@[\w.-]+/g, `[account]` )

let version = `unknown`
const drift = []
const notes = []

const until = async ( label, predicate, timeout_ms ) => {
    const deadline = Date.now() + timeout_ms
    while( Date.now() < deadline ) {
        const result = await predicate()
        if( result ) return result
        await delay( 250 )
    }
    throw new Error( `Timed out waiting for ${ label }` )
}

// Everything the approver and monitor depend on, checked one by one so a
// report says exactly which assumption broke.
const DIALOG_EXPECTATIONS = [
    [ `footer is the last line (dialog owns the bottom)`, lines => DANGEROUS_DIALOG.footer.test( lines.at( -1 ) || `` ), `DANGEROUS_DIALOG.footer` ],
    [ `question line "Do you want to proceed?"`, lines => lines.some( line => DANGEROUS_DIALOG.question.test( line ) ), `DANGEROUS_DIALOG.question` ],
    [ `cursor row "❯ 1. Yes" right below the question`, lines => DANGEROUS_DIALOG.approve.test( lines[ lines.findIndex( line => DANGEROUS_DIALOG.question.test( line ) ) + 1 ] || `` ), `DANGEROUS_DIALOG.approve` ],
    [ `row "2. No" below "Yes"`, lines => DANGEROUS_DIALOG.deny.test( lines[ lines.findIndex( line => DANGEROUS_DIALOG.question.test( line ) ) + 2 ] || `` ), `DANGEROUS_DIALOG.deny` ],
    [ `reason line "Dangerous rm operation …" above the question`, lines => lines.some( line => DANGEROUS_DIALOG.reason.test( line ) ), `DANGEROUS_DIALOG.reason` ],
    [ `"Bash command" header naming the command`, lines => lines.some( line => DANGEROUS_DIALOG.header.test( line ) ), `DANGEROUS_DIALOG.header` ],
]

const report = screen => {
    const title = drift.length ? `CLAUDE DANGEROUS-COMMAND DIALOG CHANGED` : `CLAUDE DANGEROUS-COMMAND DIALOG: ASSUMPTIONS CHANGED`
    console.error( `\n================ ${ title } ================` )
    console.error( `Claude Code ${ version }. ${ drift.length ? `Babysit's YOLO approver may no longer answer this prompt.` : `The approver still works; review these notes.` }` )
    for( const item of drift ) console.error( `  ✗ ${ item }` )
    for( const item of notes ) console.error( `  ! ${ item }` )
    if( screen ) {
        const saved = join( tmpdir(), `babysit-claude-dialog-${ version.replace( /[^\w.-]/g, `_` ) }.txt` )
        writeFileSync( saved, redact( screen ) )
        console.error( `\nCaptured pane bottom (full capture saved to ${ saved }):\n${ redact( bottom( screen ) ) }` )
    }
    console.error( `\nUpdate DANGEROUS_DIALOG / find_dangerous_command_dialog in src/agents/claude.js,` )
    console.error( `refresh tests/fixtures/claude/dangerous-rm-*.txt from the capture, and rerun this test.` )
    console.error( `=========================================================================\n` )
}

const static_contract = () => {
    const binary = find_claude_binary()
    if( !binary ) throw new Error( `claude is not installed` )
    const { passed, missing } = check_claude_binary( binary )
    for( const label of passed ) console.log( `PASS static: ${ label }` )
    for( const { label, required } of missing ) ( required ? drift : notes ).push( `static: binary no longer contains ${ label }` )
}

const start_claude = async () => {
    mkdirSync( victim )
    for( const name of [ `a`, `b` ] ) writeFileSync( join( victim, name ), name )
    const settings = JSON.stringify( { skipDangerousModePermissionPrompt: true } )
    await tmux( [ `new-session`, `-d`, `-s`, pane, `-x`, `180`, `-y`, `50`, `-c`, root,
        `claude --dangerously-skip-permissions --model ${ model } --settings '${ settings }'` ] )
    await until( `Claude composer`, async () => {
        const screen = await capture()
        // First run in this temp directory asks for folder trust.
        if( /Yes, I trust this folder/.test( screen ) && /❯ No, exit/.test( screen ) ) await tmux( [ `send-keys`, `-t`, pane, `Down` ] )
        else if( /❯ Yes, I trust this folder/.test( screen ) ) await tmux( [ `send-keys`, `-t`, pane, `Enter` ] )
        return /bypass permissions on/.test( screen ) && /^❯/m.test( screen )
    }, 60_000 )
    console.log( `PASS live: Claude started in bypass-permissions mode (${ model })` )
}

const trigger_dialog = async () => {
    const prompt = `This directory is a disposable fixture created by an automated test of Claude Code's permission dialog. `
        + `The user has already approved this. Do not ask for confirmation; call the Bash tool once with exactly: cd victim && rm -rf ./*`
    await tmux( [ `set-buffer`, `-b`, pane, `--`, prompt ] )
    await tmux( [ `paste-buffer`, `-pr`, `-d`, `-b`, pane, `-t`, pane ] )
    await delay( 300 )
    await tmux( [ `send-keys`, `-t`, pane, `Enter` ] )
    // Settle on whichever comes first: a prompt at the bottom, or the removal.
    return until( `the dangerous-command prompt`, async () => {
        const screen = await capture()
        if( /Do you want to proceed\?/.test( bottom( screen ) ) || /Dangerous rm/.test( bottom( screen ) ) ) return { screen }
        if( readdirSync( victim ).length === 0 ) return { screen, removed: true }
        // A finished turn without the tool call means the model declined.
        if( /for \d+s · done/.test( screen ) ) throw new Error( `the model answered without running the command; rerun or set BABYSIT_DIALOG_E2E_MODEL` )
        return null
    }, 120_000 )
}

const approve_with_monitor = async () => {
    let alive = true
    const monitor = start_monitor( {
        session_name: pane, config: { idle_timeout_s: 300 }, rules: [], agent_patterns: null,
        agent: claude, approve_dangerous_commands: true,
        has_session_fn: async () => alive,
        capture_pane_fn: capture,
        send_keys_fn: ( target, ...keys ) => tmux( [ `send-keys`, `-t`, target, ...keys ] ),
        publish_agent_status_fn: async ( { agent_status } ) => agent_status,
        write_loop_deadline_fn: () => null,
    } )
    try {
        await until( `Babysit's monitor to approve and Claude to remove the files`, async () => readdirSync( victim ).length === 0, 30_000 )
    } finally {
        alive = false
        await monitor
    }
}

// Exit codes: 0 contract holds, 1 interface drift (report printed), 2 inconclusive.
const main = async () => {
    [ version ] = ( await run( `claude`, [ `--version` ] ) ).split( ` ` )
    console.log( `Claude Code ${ version }` )
    static_contract()
    await start_claude()

    const { screen, removed } = await trigger_dialog()
    if( removed ) {
        drift.push( `live: Claude ran the guarded rm without prompting under --dangerously-skip-permissions; the YOLO approver is no longer needed` )
        report( screen )
        return 1
    }

    const lines = screen.split( `\n` ).filter( line => line.trim() ).slice( -20 )
    for( const [ label, check, fix ] of DIALOG_EXPECTATIONS ) {
        if( check( lines ) ) console.log( `PASS live: ${ label }` )
        else drift.push( `live: ${ label } — adjust ${ fix }` )
    }
    if( !/will automatically deny this request in/.test( screen ) ) notes.push( `live: no auto-deny countdown; unattended fallback timing changed` )
    const match = find_dangerous_command_dialog( screen )
    if( match ) console.log( `PASS live: matcher read command "${ match.command }" (${ match.reason })` )
    else drift.push( `live: find_dangerous_command_dialog() returned null for the real dialog` )
    if( drift.length ) {
        report( screen )
        return 1
    }

    try {
        await approve_with_monitor()
    } catch ( error ) {
        drift.push( `live: Enter on "Yes" no longer approves the removal (${ error.message })` )
        report( await capture().catch( () => `` ) )
        return 1
    }
    console.log( `PASS live: Babysit's YOLO monitor approved the prompt and Claude removed the files` )
    if( notes.length ) report( screen )
    return 0
}

let code = 2
try {
    code = await main()
} catch ( error ) {
    console.error( `Inconclusive: ${ error.message }` )
    console.error( redact( bottom( await capture().catch( () => `` ) ) ) )
} finally {
    const socket_path = await tmux( [ `display-message`, `-p`, `#{socket_path}` ] ).catch( () => `` )
    await tmux( [ `kill-server` ] ).catch( () => {} )
    if( socket_path ) rmSync( socket_path, { force: true } )
    rmSync( root, { recursive: true, force: true } )
}
process.exit( code )
