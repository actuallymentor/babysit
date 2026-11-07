import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { create_launch_channel, next_turn_state, FAST_POLL_MS, SLOW_POLL_MS, SILENT_POLL_MS } from '../src/sessions/launch_channel.js'
import { run } from '../src/utils/exec.js'

const cleanups = []
afterEach( () => cleanups.splice( 0 ).reverse().forEach( cleanup => cleanup() ) )

// A real capture directory read by the real in-container program, run locally
const fixture = ( { agent = `claude` } = {} ) => {
    const launch_id = randomUUID()
    const directory = `/tmp/.babysit-completion-${ launch_id }`
    mkdirSync( directory, { mode: 0o700 } )
    cleanups.push( () => rmSync( directory, { recursive: true, force: true } ) )
    const session = { babysit_id: `test`, agent, container_id: `a`.repeat( 64 ), completion_capture: { launch_id, file: `${ directory }/message.json` } }
    let now = 0
    const calls = []
    const channel = create_launch_channel( session, {
        now_fn: () => now,
        run_command: ( command, args, options, timeout ) => {
            calls.push( args )
            expect( args ).toContain( session.container_id )
            expect( timeout ).toBe( 5_000 )
            return run( `node`, args.slice( args.indexOf( `-e` ) ), options, timeout )
        },
    } )
    cleanups.push( () => channel.close() )
    let seq = 0
    const event = ( type, fields = {} ) => JSON.stringify( { version: 1, seq: ++seq, type, launch_id, agent, at: new Date( 1_800_000_000_000 + seq * 1_000 ).toISOString(), ...fields } ) + `\n`
    const append = ( ...lines ) => appendFileSync( `${ directory }/events.jsonl`, lines.join( `` ) )
    const write = ( name, value ) => writeFileSync( `${ directory }/${ name }`, JSON.stringify( value ) )
    const reply = ( extra = {} ) => ( { version: 1, launch_id, agent, session_id: `root`, turn_id: `t1`, text: `Done`, completed_at: `2026-11-07T12:00:00Z`, ...extra } )
    const identity = ( extra = {} ) => ( { version: 1, launch_id, agent, session_id: `root`, captured_at: `2026-11-07T12:00:00Z`, ...extra } )
    const poll = async () => {
        now += 60_000
        await channel.refresh()
    }
    return { channel, session, directory, calls, event, append, write, reply, identity, poll, advance: ms => { now += ms }, launch_id }
}

describe( `launch channel`, () => {

    it( `reads message, identity and events in one exec, with Unicode intact`, async () => {
        const test = fixture()
        const text = `完了 🙂\n`.repeat( 10_000 )
        test.write( `message.json`, test.reply( { text } ) )
        test.write( `identity.json`, test.identity() )
        test.append( test.event( `session_id`, { session_id: `root` } ), test.event( `turn_started`, { session_id: `root`, turn_id: `p1` } ) )
        expect( await test.channel.refresh() ).toMatchObject( { session_id: `root` } )
        expect( test.calls ).toHaveLength( 1 )
        expect( test.channel.message().text ).toBe( text )
        expect( test.channel.completion_reader.read().text ).toBe( text )
        expect( test.channel.turn() ).toMatchObject( { state: `open`, turn_id: `p1`, started_seq: 2 } )
        expect( test.channel.reports_turns() ).toBe( true )
        expect( test.channel.last_seq() ).toBe( 2 )
    } )

    it( `skips unchanged files and resumes events from its byte offset`, async () => {
        const test = fixture()
        test.write( `message.json`, test.reply() )
        test.append( test.event( `turn_started`, { turn_id: `p1` } ) )
        await test.poll()
        const first = test.channel.message()
        // Second poll: the message key matches, so no payload; only new event bytes
        test.append( test.event( `turn_completed`, { turn_id: `p1`, status: `completed` } ) )
        await test.poll()
        expect( test.channel.message() ).toBe( first )
        expect( test.channel.turn() ).toMatchObject( { state: `closed`, status: `completed`, started_seq: 1 } )
    } )

    it( `consumes only whole lines; a partial tail is re-read once finished`, async () => {
        const test = fixture()
        const line = test.event( `turn_started`, { turn_id: `p1` } )
        test.append( line.slice( 0, 20 ) )
        await test.poll()
        expect( test.channel.turn() ).toBeNull()
        test.append( line.slice( 20 ) )
        await test.poll()
        expect( test.channel.turn() ).toMatchObject( { state: `open` } )
    } )

    it( `resyncs by seq after rotation (new inode) without replaying old events`, async () => {
        const test = fixture()
        const lines = [ test.event( `turn_started` ), test.event( `turn_completed`, { status: `completed` } ) ]
        test.append( ...lines )
        await test.poll()
        // Rotation keeps the newest lines under a new inode, then appends
        writeFileSync( `${ test.directory }/rotated`, lines[ 1 ] + test.event( `turn_started`, { turn_id: `p2` } ) )
        renameSync( `${ test.directory }/rotated`, `${ test.directory }/events.jsonl` )
        await test.poll()
        expect( test.channel.turn() ).toMatchObject( { state: `open`, turn_id: `p2`, seq: 3 } )
    } )

    it( `skips to the newest whole lines when a burst exceeds the read window`, async () => {
        const test = fixture()
        const burst = Array.from( { length: 600 }, ( _, index ) => test.event( `turn_started`, { turn_id: `p${ index }-${ `x`.repeat( 100 ) }` } ) )
        test.append( ...burst, test.event( `turn_completed`, { status: `interrupted` } ) )
        await test.poll()
        expect( test.channel.turn() ).toMatchObject( { state: `closed`, status: `interrupted`, seq: 601 } )
    } )

    it( `ignores foreign, malformed and stale records, keeping the last good ones`, async () => {
        const test = fixture()
        test.write( `message.json`, test.reply() )
        test.write( `identity.json`, test.identity() )
        await test.poll()
        const [ message, identity ] = [ test.channel.message(), test.channel.identity() ]
        for( const [ reply, root ] of [
            [ { launch_id: `other` }, { launch_id: `other` } ], [ { agent: `codex` }, { agent: `codex` } ], [ { version: 2 }, { version: 2 } ],
            [ { text: `` }, { session_id: `../escape` } ], [ { completed_at: `bad` }, { captured_at: `bad` } ],
            [ { completed_at: `2020-01-01T00:00:00Z` }, { captured_at: `2020-01-01T00:00:00Z` } ],
            [ { text: `x`.repeat( 256 * 1_024 + 1 ) }, {} ],
        ] ) {
            test.write( `message.json`, test.reply( reply ) )
            test.write( `identity.json`, test.identity( root ) )
            await test.poll()
            expect( test.channel.message() ).toBe( message )
            expect( test.channel.identity().session_id ).toBe( identity.session_id )
        }
        test.append( `not json\n`, JSON.stringify( { version: 1, seq: 9, type: `turn_started`, launch_id: `other`, agent: `claude`, at: `2026-11-07T12:00:00Z` } ) + `\n`,
            JSON.stringify( { version: 1, seq: 10, type: `bogus`, launch_id: test.launch_id, agent: `claude`, at: `2026-11-07T12:00:00Z` } ) + `\n` )
        await test.poll()
        expect( test.channel.turn() ).toBeNull()
        expect( test.channel.reports_turns() ).toBe( false )
    } )

    it( `refuses symlinked and hard-linked files`, async () => {
        const test = fixture()
        writeFileSync( `${ test.directory }/elsewhere`, JSON.stringify( test.reply() ) )
        symlinkSync( `${ test.directory }/elsewhere`, `${ test.directory }/message.json` )
        await test.poll()
        expect( test.channel.message() ).toBeNull()
    } )

    it( `polls fast while a turn is open or eager, slow when closed, sparse when silent`, async () => {
        let now = 0
        let calls = 0
        let output = JSON.stringify( { message: null, identity: null, events: null } )
        const session = { babysit_id: `t`, agent: `claude`, container_id: `b`.repeat( 64 ), completion_capture: { launch_id: `11111111-1111-1111-1111-111111111111`, file: `/tmp/.babysit-completion-11111111-1111-1111-1111-111111111111/message.json` } }
        const channel = create_launch_channel( session, { now_fn: () => now, run_command: async () => {
            calls++
            return output
        } } )
        const tick_at = async ( at, options ) => {
            now = at
            channel.tick( options )
            await Promise.resolve()
            await new Promise( resolve => setImmediate( resolve ) )
        }
        await tick_at( 0 )
        await tick_at( FAST_POLL_MS )
        expect( calls ).toBe( 1 )
        await tick_at( FAST_POLL_MS, { eager: true } )
        expect( calls ).toBe( 2 )
        await tick_at( FAST_POLL_MS + SLOW_POLL_MS )
        expect( calls ).toBe( 3 )
        // Nothing seen for a minute: an old container without hooks
        await tick_at( 60_000 )
        await tick_at( 60_000 + SLOW_POLL_MS )
        expect( calls ).toBe( 4 )
        await tick_at( 60_000 + SILENT_POLL_MS )
        expect( calls ).toBe( 5 )
        // An open turn restores the fast cadence
        const line = JSON.stringify( { version: 1, seq: 1, type: `turn_started`, launch_id: session.completion_capture.launch_id, agent: `claude`, at: `2026-11-07T12:00:00Z` } ) + `\n`
        output = JSON.stringify( { events: { ino: `1`, start: 0, truncated: false, data: Buffer.from( line ).toString( `base64` ) } } )
        await tick_at( 60_000 + 2 * SILENT_POLL_MS )
        expect( channel.turn().state ).toBe( `open` )
        await tick_at( 60_000 + 2 * SILENT_POLL_MS + FAST_POLL_MS )
        expect( calls ).toBe( 7 )
        channel.close()
    } )

    it( `has one read in flight and drops results arriving after close`, async () => {
        let finish
        let calls = 0
        const fixture_session = { babysit_id: `t`, agent: `claude`, container_id: `c`.repeat( 64 ), completion_capture: { launch_id: `11111111-1111-1111-1111-111111111111`, file: `/tmp/.babysit-completion-11111111-1111-1111-1111-111111111111/message.json` } }
        const channel = create_launch_channel( fixture_session, { run_command: () => {
            calls++
            return new Promise( resolve => { finish = resolve } )
        } } )
        const first = channel.refresh()
        channel.refresh()
        expect( calls ).toBe( 1 )
        channel.close()
        finish( JSON.stringify( { identity: { key: `k`, data: Buffer.from( `{}` ).toString( `base64` ) } } ) )
        expect( await first ).toBeNull()
    } )

    it( `never executes for legacy or malformed launch metadata`, async () => {
        const launch_id = `11111111-1111-1111-1111-111111111111`
        const base = { agent: `claude`, container_id: `a`.repeat( 64 ), completion_capture: { launch_id, file: `/tmp/.babysit-completion-${ launch_id }/message.json` } }
        for( const candidate of [ {}, { ...base, completion_capture: null }, { ...base, container_id: `--privileged` },
            { ...base, completion_capture: { launch_id, file: `/etc/passwd` } } ] ) {
            const channel = create_launch_channel( candidate, { run_command: () => { throw new Error( `Unexpected Docker command` ) } } )
            expect( channel.enabled ).toBe( false )
            expect( await channel.refresh() ).toBeNull()
            channel.tick()
            expect( channel.completion_reader.read() ).toBeNull()
            channel.close()
        }
    } )

} )

describe( `turn state folding`, () => {

    const at = `2026-11-07T12:00:00Z`
    const fold = events => events.reduce( ( turn, [ type, fields = {} ], index ) => next_turn_state( turn, { type, at, seq: index + 1, ...fields } ), null )

    it( `opens, blocks on a permission prompt, and closes with the reported status`, () => {
        expect( fold( [ [ `turn_started`, { turn_id: `p1` } ] ] ) ).toMatchObject( { state: `open`, turn_id: `p1` } )
        expect( fold( [ [ `turn_started` ], [ `permission_prompt` ] ] ).state ).toBe( `blocked` )
        expect( fold( [ [ `turn_started` ], [ `permission_prompt` ], [ `turn_completed`, { status: `error` } ] ] ) ).toMatchObject( { state: `closed`, status: `error`, started_seq: 1 } )
        expect( fold( [ [ `turn_started` ], [ `exit` ] ] ) ).toMatchObject( { state: `closed`, status: `exit` } )
    } )

    it( `a Claude Escape interrupt leaves the turn open until the next start replaces it`, () => {
        // Observed on 2.1.318: UserPromptSubmit, Escape (no hook), UserPromptSubmit
        expect( fold( [ [ `turn_started`, { turn_id: `p1` } ], [ `turn_started`, { turn_id: `p2` } ] ] ) ).toMatchObject( { state: `open`, turn_id: `p2`, started_seq: 2 } )
    } )

    it( `ignores prompts outside a turn and identity changes`, () => {
        expect( fold( [ [ `permission_prompt` ] ] ) ).toBeNull()
        expect( fold( [ [ `session_id` ] ] ) ).toBeNull()
    } )

} )
