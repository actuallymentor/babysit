import { afterEach, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, relative } from 'path'

import { get_agent } from '../src/agents/index.js'
import { HANDOFF_MAX_CHARS, READ_TRANSCRIPT, build_handoff_markdown, read_parent_transcript } from '../src/sessions/handoff.js'

// Each case starts python3 for the reader: seconds on a loaded host, past bun's 5 s default
setDefaultTimeout( 30_000 )

const jsonl = records => records.map( record => JSON.stringify( record ) ).join( `\n` ) + `\n`

// Run the in-container reader against a fixture home, exactly as Docker would:
// the state roots it mounts, relocated under that home
const read = ( home, agent, ident = `` ) => {
    const roots = get_agent( agent ).state.volumes.map( volume => join( home, relative( `/home/node`, volume.target ) ) )
    const result = spawnSync( `python3`, [ `-c`, READ_TRANSCRIPT, agent, ident, ...roots ], { encoding: `utf8` } )
    if( result.status !== 0 ) throw new Error( result.stderr )
    return JSON.parse( result.stdout )
}

describe( `parent transcript reader`, () => {

    let home

    beforeEach( () => {
        home = mkdtempSync( join( tmpdir(), `babysit-handoff-` ) )
    } )

    afterEach( () => rmSync( home, { recursive: true, force: true } ) )

    it( `keeps Claude's typed prompts, replies and edited files, not its plumbing`, () => {

        const project = join( home, `.claude/projects/-workspace` )
        mkdirSync( project, { recursive: true } )
        writeFileSync( join( project, `abc.jsonl` ), jsonl( [
            { type: `user`, message: { role: `user`, content: `Running inside a Babysit container. Workspace: /workspace.` } },
            { type: `user`, message: { role: `user`, content: `Fix the login bug` } },
            { type: `user`, isMeta: true, message: { role: `user`, content: `<local-command-stdout>meta</local-command-stdout>` } },
            { type: `assistant`, message: { role: `assistant`, content: [ { type: `thinking`, thinking: `hidden` }, { type: `text`, text: `Looking at auth.js` } ] } },
            { type: `assistant`, message: { role: `assistant`, content: [ { type: `tool_use`, name: `Read`, input: { file_path: `/workspace/read-only.js` } } ] } },
            { type: `assistant`, message: { role: `assistant`, content: [ { type: `tool_use`, name: `Edit`, input: { file_path: `/workspace/auth.js` } } ] } },
            { type: `user`, message: { role: `user`, content: [ { type: `tool_result`, content: `ok` } ] } },
            { type: `assistant`, isSidechain: true, message: { role: `assistant`, content: [ { type: `text`, text: `subagent noise` } ] } },
            { type: `user`, message: { role: `user`, content: `<task-notification>done</task-notification>` } },
            { type: `user`, message: { role: `user`, content: `Now add a test` } },
        ] ) )

        const transcript = read( home, `claude`, `abc` )
        expect( transcript.transcript ).toBe( join( project, `abc.jsonl` ) )
        expect( transcript.user ).toEqual( [ `Fix the login bug`, `Now add a test` ] )
        expect( transcript.assistant ).toEqual( [ `Looking at auth.js` ] )
        expect( transcript.files ).toEqual( [ `/workspace/auth.js` ] )

    } )

    it( `reads Codex user messages from either event shape and patch paths`, () => {

        const day = join( home, `.codex/sessions/2026/10/17` )
        mkdirSync( day, { recursive: true } )
        writeFileSync( join( day, `rollout-2026-10-17T10-00-00-thread-1.jsonl` ), jsonl( [
            { type: `session_meta`, payload: { id: `thread-1` } },
            { type: `response_item`, payload: { type: `message`, role: `user`, content: [ { type: `input_text`, text: `# AGENTS.md instructions\nstuff` } ] } },
            { type: `event_msg`, payload: { type: `user_message`, message: `Refactor the parser` } },
            { type: `event_msg`, payload: { type: `item_completed`, item: { type: `UserMessage`, content: [ { type: `text`, text: `Refactor the parser` } ] } } },
            { type: `response_item`, payload: { type: `message`, role: `assistant`, content: [ { type: `output_text`, text: `Parser split into two files` } ] } },
            { type: `response_item`, payload: { type: `custom_tool_call`, name: `apply_patch`, input: `*** Begin Patch\n*** Update File: src/parse.js\n*** Add File: src/lex.js\n*** End Patch` } },
        ] ) )

        const transcript = read( home, `codex`, `thread-1` )
        expect( transcript.user ).toEqual( [ `Refactor the parser` ] )
        expect( transcript.assistant ).toEqual( [ `Parser split into two files` ] )
        expect( transcript.files ).toEqual( [ `src/parse.js`, `src/lex.js` ] )

    } )

    it( `reads OpenCode's SQLite message parts for the newest root session`, () => {

        const data = join( home, `.local/share/opencode` )
        mkdirSync( data, { recursive: true } )
        // Seeded in-process: one python start less per run than a seeding script
        const db = new Database( join( data, `opencode.db` ) )
        db.exec( `CREATE TABLE session (id text, parent_id text, time_updated integer);
CREATE TABLE message (id text, session_id text, time_created integer, data text);
CREATE TABLE part (id text, message_id text, session_id text, time_created integer, data text);` )
        db.run( `INSERT INTO session VALUES ('ses_1', NULL, 2)` )
        const message = db.prepare( `INSERT INTO message VALUES (?, 'ses_1', ?, ?)` )
        message.run( `m1`, 1, JSON.stringify( { role: `user` } ) )
        message.run( `m2`, 2, JSON.stringify( { role: `assistant` } ) )
        const part = db.prepare( `INSERT INTO part VALUES (?, ?, 'ses_1', ?, ?)` )
        part.run( `p1`, `m1`, 1, JSON.stringify( { type: `text`, text: `Ship the docs` } ) )
        part.run( `p0`, `m1`, 1, JSON.stringify( { type: `text`, text: `synthetic`, synthetic: true } ) )
        part.run( `p2`, `m2`, 2, JSON.stringify( { type: `text`, text: `Docs drafted` } ) )
        part.run( `p3`, `m2`, 3, JSON.stringify( { type: `tool`, tool: `edit`, state: { input: { filePath: `/workspace/README.md` } } } ) )
        db.close()

        const transcript = read( home, `opencode` )
        expect( transcript.user ).toEqual( [ `Ship the docs` ] )
        expect( transcript.assistant ).toEqual( [ `Docs drafted` ] )
        expect( transcript.files ).toEqual( [ `/workspace/README.md` ] )

    } )

    it( `reads a live sandbox parent through docker exec and other parents from read-only volumes`, async () => {

        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( [ command, ...args ] )
            return JSON.stringify( { transcript: `/x`, user: [], assistant: [], files: [] } )
        }
        await read_parent_transcript( { agent: `claude`, modifiers: [ `sandbox` ], container_id: `abc123`, agent_session_id: `s-1` }, { live: true, run_command } )
        await read_parent_transcript( { agent: `codex`, modifiers: [], pwd: `/work`, agent_session_id: `s-2`, image_id: `sha256:${ `a`.repeat( 64 ) }` }, { run_command } )

        expect( calls[0] ).toContain( `exec` )
        expect( calls[0] ).toContain( `abc123` )
        expect( calls[1] ).toContain( `--network` )
        expect( calls[1].some( arg => /^babysit-codex-sessions-.*:ro$/.test( arg ) ) ).toBe( true )
        expect( await read_parent_transcript( { agent: `claude`, modifiers: [ `sandbox` ] }, { run_command } ) ).toBe( null )

    } )

} )

describe( `handoff markdown`, () => {

    const parent = { babysit_id: `20261017-1`, name: `login`, agent: `claude`, modifiers: [ `yolo` ] }

    it( `leads with the task, then the latest replies, files and tree state`, () => {

        const markdown = build_handoff_markdown( {
            parent,
            transcript: { user: [ `Fix the login bug`, `Add a test` ], assistant: [ `old`, `Tests pass` ], files: [ `/workspace/auth.js` ] },
            tree: { branch: `feat/x`, base: `abcdef1234567890`, status: ` M auth.js`, diff_stat: ` auth.js | 2 +-`, unpushed: `1234 wip` },
            filesystem: `clone`,
            transcript_path: `/tmp/babysit-fork-transcript-abc.jsonl`,
        } )

        expect( markdown ).toContain( `"login" 20261017-1 (claude, flags: yolo)` )
        expect( markdown ).toContain( `snapshot clone of the parent's tree at abcdef123456` )
        expect( markdown ).toContain( `/tmp/babysit-fork-transcript-abc.jsonl` )
        expect( markdown.indexOf( `> Fix the login bug` ) ).toBeLessThan( markdown.indexOf( `> Tests pass` ) )
        expect( markdown ).toContain( `- /workspace/auth.js` )
        expect( markdown ).toContain( `1234 wip` )

    } )

    it( `drops middle requests and older replies to stay under the cap, keeping the task`, () => {

        const long = index => `${ index } ${ `x`.repeat( 1_900 ) }`
        const markdown = build_handoff_markdown( {
            parent,
            transcript: { user: Array.from( { length: 40 }, ( _, index ) => long( index ) ), assistant: Array.from( { length: 6 }, ( _, index ) => `reply ${ index } ${ `y`.repeat( 2_900 ) }` ), files: [] },
        } )

        expect( markdown.length ).toBeLessThanOrEqual( HANDOFF_MAX_CHARS )
        expect( markdown ).toContain( `earlier requests omitted` )
        expect( markdown ).toContain( `reply 5` )
        expect( markdown ).toContain( `> 39 x` )
        expect( markdown ).toContain( `1.\n> 0 x` )
        expect( markdown ).not.toContain( `> 1 x` )

    } )

    it( `says when the transcript was unreadable`, () => {

        const markdown = build_handoff_markdown( { parent, transcript: null, filesystem: `share` } )
        expect( markdown ).toContain( `could not be read` )
        expect( markdown ).toContain( `(none found)` )

    } )

} )
