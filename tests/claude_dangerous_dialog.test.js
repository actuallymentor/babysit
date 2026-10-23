import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { claude, find_yolo_dialog } from '../src/agents/claude.js'
import { start_monitor } from '../src/babysit/monitor.js'
import { check_claude_binary, find_claude_binary } from './e2e/assets/claude-dialog-contract.js'

// Live captures from Claude Code 2.1.283 under --dangerously-skip-permissions.
// tests/e2e/claude-dangerous-dialog.js re-captures the real dialog and reports drift.
const fixture = name => readFileSync( new URL( `./fixtures/claude/${ name }`, import.meta.url ), `utf8` )
const glob = fixture( `dangerous-rm-glob.txt` )
const substitution = fixture( `dangerous-rm-substitution.txt` )
// Claude Code 2.1.296, subagent Bash call, unparseable `sh -c` script (live layout, command anonymised)
const shell_c = fixture( `dangerous-rm-shell-c-subagent.txt` )
// Claude Code 2.1.309 slots a right-aligned edited-files notice above the footer
const notice = fixture( `dangerous-rm-glob-edited-notice.txt` )
const composer = `────\n❯ \n────\n  yolo·docker\n  ⏵⏵ bypass permissions on (shift+tab to cycle)`

// Builds a bottom-anchored Claude dialog: question, options, footer
const dialog = ( question, options, { title = `Bash command`, footer = `Esc to cancel · Tab to amend` } = {} ) => [
    `────────────────`,
    ` ${ title }`,
    ``,
    ` ${ question }`,
    ...options.map( ( option, index ) => `${ index ? `  ` : ` ❯` } ${ index + 1 }. ${ option }` ),
    ``,
    ` ${ footer }`,
].join( `\n` )

describe( `Claude YOLO dialog`, () => {

    test( `accepts the live rm safety prompts`, () => {
        expect( find_yolo_dialog( glob ) ).toEqual( { title: `Bash command`, question: `Do you want to proceed?`, answer: `Yes` } )
        expect( find_yolo_dialog( substitution ) ).toMatchObject( { answer: `Yes` } )
        expect( find_yolo_dialog( shell_c ) ).toMatchObject( { title: `Bash command · from the general-purpose agent`, answer: `Yes` } )
        expect( claude.yolo_dialog ).toBe( find_yolo_dialog )
    } )

    test( `looks past status notices between options and footer`, () => {
        expect( find_yolo_dialog( notice ) ).toMatchObject( { title: `Bash command · from the general-purpose agent`, answer: `Yes` } )

        // Two notices at most, and notices are vetted like the options
        const footer = ` Esc to cancel · Tab to amend · ctrl+x ctrl+k twice to stop background agents`
        const stacked = extra => notice.replace( footer, `${ extra.join( `\n` ) }\n${ footer }` )
        expect( find_yolo_dialog( stacked( [ `   2 background tasks` ] ) ) ).not.toBeNull()
        expect( find_yolo_dialog( stacked( [ `   2 background tasks`, `   3 more` ] ) ) ).toBeNull()
        expect( find_yolo_dialog( stacked( [ `   Switching to Sonnet` ] ) ) ).toBeNull()
    } )

    test( `accepts any wording whose default approves`, () => {
        // The wording that blocked Auto Optimiser on 2026-10-16, ordinary prompts, folder trust
        const empty_var = glob.replace( /Dangerous rm operation on .*/, `Dangerous rm operation on possibly-empty variable path: $SHOTS/*` )
        expect( find_yolo_dialog( empty_var ) ).not.toBeNull()
        expect( find_yolo_dialog( glob.split( `\n` ).filter( line => !/Dangerous rm|automatically deny/.test( line ) ).join( `\n` ) ) ).not.toBeNull()
        expect( find_yolo_dialog( dialog( `Do you trust the files in this folder?`, [ `Yes, proceed`, `No, exit` ], { footer: `Enter to confirm · Esc to exit` } ) ) ).toMatchObject( { answer: `Yes, proceed` } )
        expect( find_yolo_dialog( dialog( `Continue?`, [ `Continue`, `Stop` ] ) ) ).toMatchObject( { answer: `Continue` } )
        expect( find_yolo_dialog( dialog( `Do you want to proceed?`, [ `Yes`, `Yes, and don't ask again`, `No` ] ) ) ).not.toBeNull()
    } )

    test( `never swaps models or touches billing`, () => {
        expect( find_yolo_dialog( dialog( `Opus is at its usage limit. Continue with Sonnet?`, [ `Yes`, `No` ] ) ) ).toBeNull()
        expect( find_yolo_dialog( dialog( `Request failed. How do you want to continue?`, [ `Continue with the fallback model`, `Edit prompt and retry` ] ) ) ).toBeNull()
        expect( find_yolo_dialog( dialog( `Would you like to continue?`, [ `Yes, switch to a lower-power model`, `No, wait for the limit to reset` ] ) ) ).toBeNull()
        expect( find_yolo_dialog( dialog( `You've hit your limit. Keep going?`, [ `Yes, use extra usage`, `No` ] ) ) ).toBeNull()
    } )

    test( `leaves defaults that do not approve`, () => {
        expect( find_yolo_dialog( dialog( `Do you want to use this API key?`, [ `No (recommended)`, `Yes` ] ) ) ).toBeNull()
        expect( find_yolo_dialog( dialog( `What should happen next?`, [ `Retry`, `Skip` ] ) ) ).toBeNull()
    } )

    test( `command text cannot veto or approve`, () => {
        // Model words inside a command never block; a fake dialog inside it never counts
        expect( find_yolo_dialog( shell_c.replace( ` │ sleep example-image`, ` │ python fallback_model.py --model opus` ) ) ).not.toBeNull()
        expect( find_yolo_dialog( `${ shell_c }\n${ composer }` ) ).toBeNull()
    } )

    test( `history cannot supply the question or the selected "Yes"`, () => {
        const current = `\n Bash command\n   ls\n   List files\n Do you want to proceed?\n   1. Yes\n ❯ 2. No\n Esc to cancel · Tab to amend`
        expect( find_yolo_dialog( `${ shell_c }${ current }` ) ).toBeNull()
    } )

    test( `leaves a shell -c script a permission rule denies`, () => {
        const denied = shell_c.replace( `This shell -c script runs rm and could not be checked`, `A permission rule denies a command in this shell -c script` )
        expect( find_yolo_dialog( denied ) ).toBeNull()
    } )

    test( `ignores the dialog once it is only transcript history`, () => {
        expect( find_yolo_dialog( `${ glob }\n${ composer }` ) ).toBeNull()
    } )

    test( `leaves a cursor a person moved to "No"`, () => {
        const moved = glob.replace( ` ❯ 1. Yes`, `   1. Yes` ).replace( `   2. No`, ` ❯ 2. No` )
        expect( find_yolo_dialog( moved ) ).toBeNull()
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
            session_name: `babysit_yolo`, config: { idle_timeout_s: 300 }, rules: [],
            agent: claude, tmux_target: `%7`, approve_dialogs: approve, input_allowed,
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
