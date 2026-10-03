import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { claude, find_dangerous_command_dialog } from '../src/agents/claude.js'
import { start_monitor } from '../src/babysit/monitor.js'
import { check_claude_binary, find_claude_binary } from './e2e/assets/claude-dialog-contract.js'

// Live captures from Claude Code 2.1.283 under --dangerously-skip-permissions.
// tests/e2e/claude-dangerous-dialog.js re-captures the real dialog and reports drift.
const fixture = name => readFileSync( new URL( `./fixtures/claude/${ name }`, import.meta.url ), `utf8` )
const glob = fixture( `dangerous-rm-glob.txt` )
const substitution = fixture( `dangerous-rm-substitution.txt` )
const composer = `────\n❯ \n────\n  yolo·docker\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`

describe( `Claude dangerous-command dialog`, () => {

    test( `recognises the live glob and command-substitution variants`, () => {
        expect( find_dangerous_command_dialog( glob ) ).toEqual( {
            command: `cd victim && rm -rf ./*`,
            reason: `Dangerous rm operation on statically-unresolvable target: /workspace/project/*`,
        } )
        expect( find_dangerous_command_dialog( substitution ) ).toMatchObject( {
            command: `rm -rf $(echo /workspace/project/victim2)`,
            reason: `Dangerous rm operation on statically-unresolvable target: command substitution output`,
        } )
        expect( claude.dangerous_command_dialog ).toBe( find_dangerous_command_dialog )
    } )

    test( `ignores the dialog once it is only transcript history`, () => {
        expect( find_dangerous_command_dialog( `${ glob }\n${ composer }` ) ).toBeNull()
    } )

    test( `leaves a cursor a person moved to "No"`, () => {
        const moved = glob.replace( ` ❯ 1. Yes`, `   1. Yes` ).replace( `   2. No`, ` ❯ 2. No` )
        expect( find_dangerous_command_dialog( moved ) ).toBeNull()
    } )

    test( `ignores ordinary permission prompts`, () => {
        const ordinary = glob.split( `\n` ).filter( line => !/Dangerous rm|automatically deny/.test( line ) ).join( `\n` )
        expect( find_dangerous_command_dialog( ordinary ) ).toBeNull()
    } )

} )

// Early warning without a model call: the installed Claude still ships the
// dialog strings the approver matches. Skipped where Claude is absent (CI).
// On failure, run `npm run test:claude-dialog` for a live capture and report.
const binary = find_claude_binary()
describe.skipIf( !binary )( `installed Claude dialog contract`, () => {

    test( `still carries the dangerous-command dialog strings`, () => {
        const { missing } = check_claude_binary( binary )
        const required = missing.filter( item => item.required ).map( item => item.label )
        const changed = missing.filter( item => !item.required ).map( item => item.label )
        if( missing.length ) console.warn( [
            `Claude dangerous-command dialog changed in ${ binary }:`,
            ...required.map( label => `  ✗ missing ${ label } (YOLO approval will break)` ),
            ...changed.map( label => `  ! missing ${ label } (when/why YOLO sees the prompt changed)` ),
            `Run npm run test:claude-dialog, then update src/agents/claude.js and tests/fixtures/claude/.`,
        ].join( `\n` ) )
        expect( required ).toEqual( [] )
    // The installed binary is ~250 MB; a cold read alone can take seconds.
    }, 60_000 )

} )

describe( `YOLO monitor approval`, () => {

    const run = async ( { approve = true, input_allowed = () => true, ticks = 4 } = {} ) => {
        let screen = glob
        let alive = 0
        const sent = []
        await start_monitor( {
            session_name: `babysit_yolo`, config: { idle_timeout_s: 300 }, rules: [], agent_patterns: null,
            agent: claude, tmux_target: `%7`, approve_dangerous_commands: approve, input_allowed,
            has_session_fn: async () => ++alive <= ticks,
            capture_pane_fn: async () => screen,
            send_keys_fn: async ( target, key ) => {
                sent.push( [ target, key ] )
                // Claude closes the dialog and runs the command.
                screen = `${ glob }\n${ composer }`
            },
            publish_agent_status_fn: async ( { agent_status } ) => agent_status,
            write_loop_deadline_fn: () => null,
            wait_fn: async () => null,
        } )
        return sent
    }

    test( `answers "Yes" once in the agent pane`, async () => {
        expect( await run() ).toEqual( [ [ `%7`, `Enter` ] ] )
    } )

    test( `leaves the prompt for Claude to auto-deny when disabled`, async () => {
        expect( await run( { approve: false } ) ).toEqual( [] )
    } )

    test( `does not type while recovery owns the pane`, async () => {
        expect( await run( { input_allowed: () => false } ) ).toEqual( [] )
    } )

} )
