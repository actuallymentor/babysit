import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { COMPLETION_HELPER_SOURCE, COMPLETION_PLUGIN_SOURCE, COMPLETION_HELPER_PATH, add_completion_hooks } from '../src/agents/completion_capture.js'

// Run the same launch and hook programs staged into Docker. A tiny executable
// stands in for each CLI, exercising real process ancestry and file handoff.
describe( `completed response capture`, () => {

    let directory
    let helper
    let message_file
    let fixture
    let env

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-capture-` ) )
        helper = join( directory, `capture.py` )
        message_file = join( directory, `output`, `message.json` )
        fixture = join( directory, `agent` )
        writeFileSync( helper, COMPLETION_HELPER_SOURCE )
        writeFileSync( fixture, `#!/usr/bin/env node
const {spawnSync} = require('node:child_process')
const {readFileSync} = require('node:fs')
const payloads = JSON.parse(readFileSync(process.env.PAYLOADS_FILE, 'utf8'))
const agent = process.env.AGENT
const helper = process.env.HELPER
if(agent === 'codex') {
    const notify = JSON.parse(process.argv[3].slice('notify='.length))
    for(const payload of payloads) spawnSync(notify[0], [...notify.slice(1), JSON.stringify(payload)])
} else {
    for(const payload of payloads) {
        if(payload.nested) {
            const code = "require('node:child_process').spawnSync('python3', [process.env.HELPER, process.env.AGENT], {input: process.env.NESTED_PAYLOAD})"
            spawnSync('node', ['-e', code], {env: {...process.env, NESTED_PAYLOAD: JSON.stringify(payload)}})
        } else spawnSync('python3', [helper, agent, payload.hook_event_name || ''], {input: JSON.stringify(payload)})
    }
}
` )
        chmodSync( fixture, 0o755 )
        env = { ...process.env, HELPER: helper, HOME: directory, CODEX_HOME: directory, BABYSIT_COMPLETION_FILE: message_file, BABYSIT_COMPLETION_LAUNCH_ID: `launch-1` }
        delete env.BABYSIT_RECOVERY_IDENTITY
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    const execute = ( agent, payloads, args = [] ) => {
        const payload_file = join( directory, `payloads.json` )
        writeFileSync( payload_file, JSON.stringify( payloads ) )
        const result = spawnSync( `python3`, [ helper, `launch`, agent, fixture, ...args ], {
            env: { ...env, AGENT: agent, PAYLOADS_FILE: payload_file }, encoding: `utf8`,
        } )
        expect( result.status ).toBe( 0 )
        expect( result.stderr ).toBe( `` )
        return existsSync( message_file ) ? JSON.parse( readFileSync( message_file, `utf8` ) ) : null
    }

    const codex_metadata = ( id, source ) => {
        mkdirSync( join( directory, `sessions` ), { recursive: true } )
        writeFileSync( join( directory, `sessions`, `rollout-date-${ id }.jsonl` ), JSON.stringify( { type: `session_meta`, payload: { id, source } } ) + `\n` )
    }

    it( `publishes durable identity on SessionStart before any completion`, () => {
        expect( execute( `claude`, [ { hook_event_name: `SessionStart`, session_id: `root` } ] ) ).toBeNull()
        const identity = JSON.parse( readFileSync( join( directory, `output`, `identity.json` ), `utf8` ) )
        expect( identity ).toMatchObject( { version: 1, launch_id: `launch-1`, agent: `claude`, session_id: `root` } )
        expect( Number.isFinite( Date.parse( identity.captured_at ) ) ).toBe( true )
    } )

    it( `persists the newest root binding in the mounted state before host polling`, () => {
        const state = join( directory, `state` )
        mkdirSync( state )
        writeFileSync( helper, COMPLETION_HELPER_SOURCE.replace( `'/home/node/.claude/projects'`, JSON.stringify( state ) ) )
        env.BABYSIT_RECOVERY_IDENTITY = `1`
        execute( `claude`, [ { hook_event_name: `SessionStart`, session_id: `old` }, { hook_event_name: `SessionStart`, session_id: `new` } ] )
        const mirror = JSON.parse( readFileSync( join( state, `.babysit-identities`, `launch-1.json` ), `utf8` ) )
        expect( mirror.session_id ).toBe( `new` )
        expect( mirror ).toEqual( JSON.parse( readFileSync( join( directory, `output`, `identity.json` ), `utf8` ) ) )
    } )

    it( `captures only the final Claude reply and preserves it through empty events`, () => {
        const record = execute( `claude`, [
            { hook_event_name: `SessionStart`, session_id: `root` },
            { hook_event_name: `SubagentStop`, session_id: `root`, last_assistant_message: `Child reply` },
            { hook_event_name: `Stop`, session_id: `root`, last_assistant_message: `Final **answer**\n\nOnly this message.` },
            { hook_event_name: `Stop`, session_id: `root`, last_assistant_message: `` },
        ] )
        expect( record.text ).toBe( `Final **answer**\n\nOnly this message.` )
        expect( record.launch_id ).toBe( `launch-1` )
        expect( record.session_id ).toBe( `root` )
    } )

    it( `rejects a nested CLI before it can claim the launch`, () => {
        const record = execute( `claude`, [
            { nested: true, hook_event_name: `Stop`, session_id: `nested`, last_assistant_message: `Wrong` },
            { hook_event_name: `Stop`, session_id: `root`, last_assistant_message: `Right` },
            { hook_event_name: `Stop`, session_id: `other`, last_assistant_message: `Wrong` },
        ] )
        expect( record.text ).toBe( `Right` )
    } )

    it( `bounds oversized replies with an explicit notice`, () => {
        const record = execute( `claude`, [ { hook_event_name: `Stop`, session_id: `root`, last_assistant_message: `🙂`.repeat( 70_000 ) } ] )
        expect( Buffer.byteLength( record.text ) ).toBeLessThanOrEqual( 256 * 1024 )
        expect( record.text ).toEndWith( `[Message truncated at 256 KiB]` )
    } )

    it( `rejects Codex child threads and chains a multiline TOML notification`, () => {
        codex_metadata( `child`, { subagent: { parent_thread_id: `root` } } )
        codex_metadata( `root`, `cli` )
        const original = join( directory, `original.json` )
        writeFileSync( join( directory, `config.toml` ), `notify = [\n 'node', '-e', 'require("fs").writeFileSync(process.argv[1], process.argv[2])',\n '${ original }',\n]\n` )
        const record = execute( `codex`, [
            { type: `agent-turn-complete`, 'thread-id': `child`, 'last-assistant-message': `Wrong` },
            { type: `agent-turn-complete`, 'thread-id': `root`, 'turn-id': `turn-1`, 'last-assistant-message': `Root final` },
        ] )
        expect( record.text ).toBe( `Root final` )
        expect( record.turn_id ).toBe( `turn-1` )
        expect( JSON.parse( readFileSync( original, `utf8` ) )[ `last-assistant-message` ] ).toBe( `Root final` )
    } )

    it( `accepts the native child of the symlinked Codex npm entrypoint`, () => {
        codex_metadata( `root`, `cli` )
        const node_path = spawnSync( `node`, [ `-p`, `process.execPath` ], { encoding: `utf8` } ).stdout.trim()
        const native = join( directory, `native`, `codex` )
        const shim = join( directory, `codex.js` )
        const child = join( directory, `child.cjs` )
        mkdirSync( join( directory, `native` ) )
        symlinkSync( node_path, native )
        writeFileSync( shim, `#!/usr/bin/env node
const {spawnSync} = require('child_process')
const notify = JSON.parse(process.argv[3].slice('notify='.length))
spawnSync(${ JSON.stringify( native ) }, [${ JSON.stringify( child ) }], {env: {...process.env, NOTIFY: JSON.stringify(notify)}})
` )
        writeFileSync( child, `const {spawnSync} = require('child_process')
const notify = JSON.parse(process.env.NOTIFY)
spawnSync(notify[0], [...notify.slice(1), JSON.stringify({type: 'agent-turn-complete', 'thread-id': 'root', 'last-assistant-message': 'Native child reply'})])
` )
        chmodSync( shim, 0o755 )
        rmSync( fixture )
        symlinkSync( shim, fixture )
        expect( execute( `codex`, [] ).text ).toBe( `Native child reply` )
    } )

    it( `rejects a nested native Codex resuming app-server history`, () => {
        codex_metadata( `nested`, `vscode` )
        const node_path = spawnSync( `node`, [ `-p`, `process.execPath` ], { encoding: `utf8` } ).stdout.trim()
        const native = join( directory, `codex` )
        const child = join( directory, `child.cjs` )
        symlinkSync( node_path, native )
        writeFileSync( fixture, `process.env.BABYSIT_COMPLETION_ROOT_PID = String(process.pid)
require('child_process').spawnSync(${ JSON.stringify( native ) }, [${ JSON.stringify( child ) }])
` )
        writeFileSync( child, `require('child_process').spawnSync('python3', [process.env.HELPER, 'codex', '[]', JSON.stringify({type: 'agent-turn-complete', 'thread-id': 'nested', 'last-assistant-message': 'Nested reply'})])
` )
        const result = spawnSync( native, [ fixture ], { env, encoding: `utf8` } )
        expect( result.status ).toBe( 0 )
        expect( result.stderr ).toBe( `` )
        expect( existsSync( message_file ) ).toBe( false )
    } )

    it( `honors an explicit Codex notification override and captures before it fails`, () => {
        codex_metadata( `root`, `cli` )
        const record = execute( `codex`, [ { type: `agent-turn-complete`, 'thread-id': `root`, 'last-assistant-message': `Final` } ], [ `-c`, `notify=["false"]` ] )
        expect( record.text ).toBe( `Final` )
    } )

    it( `leaves native startup intact when the optional notification config cannot be parsed`, () => {
        const arguments_file = join( directory, `arguments.json` )
        writeFileSync( join( directory, `config.toml` ), `notify = [invalid TOML` )
        writeFileSync( fixture, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${ JSON.stringify( arguments_file ) }, JSON.stringify(process.argv.slice(2)))\n` )
        const result = spawnSync( `python3`, [ helper, `launch`, `codex`, fixture, `--version` ], { env, encoding: `utf8` } )
        expect( result.status ).toBe( 0 )
        expect( result.stderr ).toBe( `` )
        expect( JSON.parse( readFileSync( arguments_file, `utf8` ) ) ).toEqual( [ `--version` ] )
    } )

    it( `captures app-server roots after native resume while excluding child sessions`, () => {
        codex_metadata( `root`, `vscode` )
        codex_metadata( `child`, { subagent: { parent_thread_id: `root` } } )
        const root = { type: `agent-turn-complete`, 'thread-id': `root`, 'last-assistant-message': `Managed final` }
        delete env.BABYSIT_EFFORT_AGENT
        delete env.BABYSIT_EFFORT_ENDPOINT
        expect( execute( `codex`, [
            root,
            { type: `agent-turn-complete`, 'thread-id': `child`, 'last-assistant-message': `Wrong native child` },
        ] ).text ).toBe( `Managed final` )

        env.BABYSIT_EFFORT_AGENT = `codex`
        env.BABYSIT_EFFORT_ENDPOINT = `ws://127.0.0.1:12345`
        expect( execute( `codex`, [
            root,
            { type: `agent-turn-complete`, 'thread-id': `child`, 'last-assistant-message': `Wrong child` },
        ] ).text ).toBe( `Managed final` )
    } )

    it( `resolves the same original notify chain for the remote completion bridge`, () => {
        writeFileSync( join( directory, `config.toml` ), `notify = ['from-file']\n` )
        const command = [ `codex`, `-c`, `notify=["first"]`, `--config=notify=["last", "argument with spaces"]` ]
        const result = spawnSync( `python3`, [ helper, `notify-command`, JSON.stringify( command ) ], { env, encoding: `utf8` } )
        expect( result.status ).toBe( 0 )
        expect( JSON.parse( result.stdout ) ).toEqual( [ `last`, `argument with spaces` ] )
        expect( existsSync( message_file ) ).toBe( false )
    } )

    it( `fails closed for Codex notifications without matching native metadata`, () => {
        expect( execute( `codex`, [ { type: `agent-turn-complete`, 'thread-id': `unknown`, 'last-assistant-message': `Wrong` } ] ) ).toBeNull()
    } )

    it( `follows a new authoritative root session after /clear`, () => {
        const record = execute( `claude`, [
            { hook_event_name: `SessionStart`, session_id: `old` },
            { hook_event_name: `Stop`, session_id: `old`, last_assistant_message: `Old reply` },
            { hook_event_name: `SessionStart`, session_id: `new` },
            { hook_event_name: `Stop`, session_id: `new`, last_assistant_message: `New reply` },
        ] )
        expect( record.session_id ).toBe( `new` )
        expect( record.text ).toBe( `New reply` )
    } )

    it( `OpenCode verifies an explicit resumed root before any new message`, () => {
        const plugin = join( directory, `plugin.mjs` )
        writeFileSync( plugin, COMPLETION_PLUGIN_SOURCE.replaceAll( COMPLETION_HELPER_PATH, helper ) )
        writeFileSync( fixture, `#!/usr/bin/env node
async function main() {
    const { BabysitCompletion } = await import(${ JSON.stringify( plugin ) })
    await BabysitCompletion({client: {session: {get: async ({path}) => ({data: {id: path.id}})}}})
}
main()
` )
        expect( execute( `opencode`, [], [ `--session`, `ses_root` ] ) ).toBeNull()
        expect( JSON.parse( readFileSync( join( directory, `output`, `identity.json` ), `utf8` ) ).session_id ).toBe( `ses_root` )
    } )

    it( `OpenCode selects completed visible text from the active root session`, () => {
        const plugin = join( directory, `plugin.mjs` )
        writeFileSync( plugin, COMPLETION_PLUGIN_SOURCE.replace( COMPLETION_HELPER_PATH, helper ) )
        writeFileSync( fixture, `#!/usr/bin/env node
async function main() {
    const { BabysitCompletion } = await import(${ JSON.stringify( plugin ) })
    let current = {
        info: {role: 'assistant', id: 'reply', time: {completed: 1}, finish: 'stop'},
        parts: [{type: 'tool', text: 'Tool output'}, {type: 'reasoning', text: 'Thinking'}, {type: 'text', synthetic: true, text: 'Synthetic'}, {type: 'text', text: 'Only the final reply'}],
    }
    const client = {session: {
        get: async ({path}) => ({data: {id: path.id, parentID: path.id === 'child' ? 'root' : undefined}}),
        messages: async () => ({data: [{info: {role: 'user'}}, current]}),
    }}
    const hooks = await BabysitCompletion({client})
    await hooks['chat.message']({sessionID: 'root'})
    await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'root'}}})
    await hooks['chat.message']({sessionID: 'child'})
    await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'child'}}})
    current = {info: {role: 'assistant', time: {completed: 1}, finish: 'tool-calls'}, parts: [{type: 'text', text: 'Intermediate'}]}
    await hooks.event({event: {type: 'session.idle', properties: {sessionID: 'root'}}})
}
main()
` )
        const record = execute( `opencode`, [] )
        expect( record.session_id ).toBe( `root` )
        expect( record.text ).toBe( `Only the final reply` )
    } )

    it( `adds capture beside existing hook definitions`, () => {
        const user_hook = { hooks: [ { type: `command`, command: `original` } ] }
        const settings = add_completion_hooks( { hooks: { Stop: [ user_hook ] } }, `claude` )
        expect( settings.hooks.Stop[ 0 ] ).toEqual( user_hook )
        expect( settings.hooks.Stop ).toHaveLength( 2 )
        for( const name of [ `SessionStart`, `UserPromptSubmit`, `StopFailure`, `Notification` ] ) expect( settings.hooks[ name ] ).toHaveLength( 1 )
        expect( settings.hooks.Notification[ 0 ].matcher ).toBe( `permission_prompt` )
    } )

    describe( `launch event channel`, () => {

        const events = () => {
            const file = join( directory, `output`, `events.jsonl` )
            if( !existsSync( file ) ) return []
            return readFileSync( file, `utf8` ).trim().split( `\n` ).map( line => JSON.parse( line ) )
        }
        // Shape only: timestamps and the fixed envelope are checked once
        const shapes = () => events().map( ( { version, launch_id, at, ...event } ) => {
            expect( version ).toBe( 1 )
            expect( launch_id ).toBe( `launch-1` )
            expect( Number.isFinite( Date.parse( at ) ) ).toBe( true )
            return event
        } )

        it( `Claude: identity, turns, permission prompts and failures as observed on 2.1.318`, () => {
            const record = execute( `claude`, [
                { hook_event_name: `SessionStart`, session_id: `root`, source: `startup` },
                { hook_event_name: `UserPromptSubmit`, session_id: `root`, prompt_id: `p1`, prompt: `ping` },
                { hook_event_name: `Stop`, session_id: `root`, prompt_id: `p1`, last_assistant_message: `Pong reply.`, background_tasks: [] },
                { hook_event_name: `UserPromptSubmit`, session_id: `root`, prompt_id: `p2` },
                { hook_event_name: `Notification`, session_id: `root`, notification_type: `idle_prompt`, message: `Claude is waiting` },
                { hook_event_name: `Notification`, session_id: `root`, notification_type: `permission_prompt`, message: `Claude needs your permission` },
                { hook_event_name: `StopFailure`, session_id: `root`, prompt_id: `p2`, error: `server_error`, last_assistant_message: `API Error: 500` },
                { hook_event_name: `SubagentStop`, session_id: `root`, agent_id: `child`, last_assistant_message: `Child` },
            ] )
            expect( shapes() ).toEqual( [
                { seq: 1, type: `session_id`, agent: `claude`, session_id: `root` },
                { seq: 2, type: `turn_started`, agent: `claude`, session_id: `root`, turn_id: `p1` },
                { seq: 3, type: `turn_completed`, agent: `claude`, session_id: `root`, turn_id: `p1`, status: `completed` },
                { seq: 4, type: `turn_started`, agent: `claude`, session_id: `root`, turn_id: `p2` },
                { seq: 5, type: `permission_prompt`, agent: `claude`, session_id: `root`, message: `Claude needs your permission` },
                { seq: 6, type: `turn_completed`, agent: `claude`, session_id: `root`, turn_id: `p2`, status: `error`, error: `server_error` },
            ] )
            // An API error is no reply: the web bridge keeps the last real one
            expect( record.text ).toBe( `Pong reply.` )
        } )

        it( `Claude: a nested CLI and a foreign session emit nothing; /clear rebinds`, () => {
            execute( `claude`, [
                { hook_event_name: `SessionStart`, session_id: `old` },
                { nested: true, hook_event_name: `UserPromptSubmit`, session_id: `nested`, prompt_id: `n1` },
                { hook_event_name: `UserPromptSubmit`, session_id: `foreign`, prompt_id: `f1` },
                { hook_event_name: `SessionStart`, session_id: `new`, source: `clear` },
            ] )
            expect( shapes().map( event => [ event.type, event.session_id ] ) ).toEqual( [ [ `session_id`, `old` ], [ `session_id`, `new` ] ] )
        } )

        it( `Codex: notify completions plus app-server turn boundaries`, () => {
            codex_metadata( `root`, `vscode` )
            execute( `codex`, [
                { type: `babysit-session-identity`, 'thread-id': `root` },
                { type: `babysit-turn-started`, 'thread-id': `root`, 'turn-id': `t1` },
                { type: `babysit-turn-ended`, 'thread-id': `root`, 'turn-id': `t1`, status: `interrupted` },
                { type: `babysit-turn-started`, 'thread-id': `root`, 'turn-id': `t2` },
                { type: `agent-turn-complete`, 'thread-id': `root`, 'turn-id': `t2`, 'last-assistant-message': `Done` },
            ] )
            expect( shapes().map( ( { type, turn_id, status } ) => [ type, turn_id, status ] ) ).toEqual( [
                [ `session_id`, undefined, undefined ],
                [ `turn_started`, `t1`, undefined ],
                [ `turn_completed`, `t1`, `interrupted` ],
                [ `turn_started`, `t2`, undefined ],
                [ `turn_completed`, `t2`, `completed` ],
            ] )
        } )

        it( `OpenCode: one turn_started per busy stretch; aborts complete as interrupted`, () => {
            const plugin = join( directory, `plugin.mjs` )
            writeFileSync( plugin, COMPLETION_PLUGIN_SOURCE.replace( COMPLETION_HELPER_PATH, helper ) )
            writeFileSync( fixture, `#!/usr/bin/env node
async function main() {
    const { BabysitCompletion } = await import(${ JSON.stringify( plugin ) })
    let latest = {info: {role: 'assistant', id: 'm1', time: {completed: 1}, finish: 'stop'}, parts: [{type: 'text', text: 'Reply'}]}
    const client = {session: {get: async ({path}) => ({data: {id: path.id}}), messages: async () => ({data: [latest]})}}
    const hooks = await BabysitCompletion({client})
    const event = (type, properties) => hooks.event({event: {type, properties: {sessionID: 'ses_root', ...properties}}})
    await hooks['chat.message']({sessionID: 'ses_root'})
    await event('session.status', {status: {type: 'busy'}})
    await event('session.status', {status: {type: 'busy'}})
    await event('session.status', {sessionID: 'ses_child', status: {type: 'busy'}})
    await event('session.idle')
    latest = {info: {role: 'assistant', id: 'm2', time: {}, error: {name: 'MessageAbortedError'}}, parts: []}
    await event('session.status', {status: {type: 'busy'}})
    await event('session.idle')
}
main()
` )
            expect( execute( `opencode`, [] ).text ).toBe( `Reply` )
            expect( shapes().map( ( { type, turn_id, status, error } ) => [ type, turn_id, status, error ] ) ).toEqual( [
                [ `session_id`, undefined, undefined, undefined ],
                [ `turn_started`, undefined, undefined, undefined ],
                [ `turn_completed`, `m1`, `completed`, undefined ],
                [ `turn_started`, undefined, undefined, undefined ],
                [ `turn_completed`, `m2`, `interrupted`, `MessageAbortedError` ],
            ] )
        } )

        it( `bounds the file by keeping the newest whole lines with monotonic seq`, () => {
            // A 4 KiB bound stands in for 256 KiB: same code path, fewer processes
            writeFileSync( helper, COMPLETION_HELPER_SOURCE.replace( `EVENTS_MAX_BYTES = 256 * 1024`, `EVENTS_MAX_BYTES = 4096` ) )
            const payloads = Array.from( { length: 40 }, ( _, index ) => ( { hook_event_name: `UserPromptSubmit`, session_id: `root`, prompt_id: `p${ index }-${ `x`.repeat( 100 ) }` } ) )
            execute( `claude`, payloads )
            expect( readFileSync( join( directory, `output`, `events.jsonl` ) ).length ).toBeLessThanOrEqual( 4096 )
            const kept = events()
            expect( kept.length ).toBeLessThan( 41 )
            expect( kept.at( -1 ) ).toMatchObject( { seq: 41, turn_id: `p39-${ `x`.repeat( 100 ) }` } )
            kept.forEach( ( event, index ) => index && expect( event.seq ).toBe( kept[ index - 1 ].seq + 1 ) )
        }, 30_000 )

        it( `appends the exit event with or without a durable receipt`, () => {
            const result = spawnSync( `python3`, [ helper, `exit`, `claude`, `143`, `1` ], { env, encoding: `utf8` } )
            expect( result.status ).toBe( 0 )
            expect( shapes() ).toEqual( [ { seq: 1, type: `exit`, agent: `claude`, exit_status: 143, interrupted: true } ] )
        } )

    } )

} )
