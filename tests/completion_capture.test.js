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
        } else spawnSync('python3', [helper, agent], {input: JSON.stringify(payload)})
    }
}
` )
        chmodSync( fixture, 0o755 )
        env = { ...process.env, HELPER: helper, CODEX_HOME: directory, BABYSIT_COMPLETION_FILE: message_file, BABYSIT_COMPLETION_LAUNCH_ID: `launch-1` }
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

    it( `captures Gemini AfterAgent and ignores model steps`, () => {
        const record = execute( `gemini`, [
            { hook_event_name: `AfterModel`, session_id: `root`, prompt_response: `Intermediate` },
            { hook_event_name: `AfterAgent`, session_id: `root`, prompt_response: `Finished` },
        ] )
        expect( record.text ).toBe( `Finished` )
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

    it( `rejects a nested native Codex when the root is already native`, () => {
        codex_metadata( `nested`, `cli` )
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
        expect( settings.hooks.SessionStart ).toHaveLength( 1 )
    } )

} )
