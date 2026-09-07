import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'crypto'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { create_completion_reader } from '../src/web_bridge/completion.js'
import { run } from '../src/utils/exec.js'

const launch_id = `12345678-1234-1234-1234-123456789abc`
const session = {
    babysit_id: `test-session`,
    agent: `codex`,
    container_id: `a`.repeat( 64 ),
    completion_capture: {
        launch_id,
        file: `/tmp/.babysit-completion-${ launch_id }/message.json`,
    },
}
const reply = ( overrides = {} ) => ( {
    version: 1,
    launch_id,
    agent: `codex`,
    session_id: `native-session`,
    turn_id: `turn-1`,
    text: `# Finished\n\nOnly the final reply.`,
    completed_at: `2026-09-07T12:00:00.000Z`,
    ...overrides,
} )
const encode = value => Buffer.from( value ).toString( `base64` )
const settle = () => new Promise( resolve => setImmediate( resolve ) )

describe( `completed reply reader`, () => {

    it( `executes the bounded reader with Unicode text and refuses a symlink`, async () => {
        const id = randomUUID()
        const file = `/tmp/.babysit-completion-${ id }/message.json`
        mkdirSync( dirname( file ), { mode: 0o700 } )
        let task
        let now = 0
        const reader = create_completion_reader( {
            ...session, completion_capture: { launch_id: id, file },
        }, {
            now_fn: () => now,
            run_command: ( command, args, options, timeout ) => {
                task = run( `node`, args.slice( args.indexOf( `-e` ) ), options, timeout )
                return task
            },
        } )
        try {
            const text = `完了 🙂\n`.repeat( 10_000 )
            writeFileSync( file, JSON.stringify( reply( { launch_id: id, text } ) ) )
            reader.read()
            await task
            await settle()
            expect( reader.read().text ).toBe( text )

            rmSync( file )
            writeFileSync( `${ file }.other`, JSON.stringify( reply( { launch_id: id, text: `Do not follow` } ) ) )
            symlinkSync( `${ file }.other`, file )
            now += 2_000
            reader.read()
            await task.catch( () => {} )
            await settle()
            expect( reader.read().text ).toBe( text )
        } finally {
            reader.close()
            rmSync( dirname( file ), { recursive: true, force: true } )
        }
    } )

    it( `polls without blocking, deduplicates replies, and accepts a root session switch`, async () => {
        let now = 0
        let output = reply()
        let calls = 0
        const reader = create_completion_reader( session, {
            now_fn: () => now,
            run_command: async ( command, args, options, timeout ) => {
                calls++
                expect( args ).toContain( session.container_id )
                expect( args ).toContain( session.completion_capture.file )
                expect( timeout ).toBe( 5_000 )
                return encode( JSON.stringify( output ) )
            },
        } )
        expect( reader.read() ).toBeNull()
        await settle()
        const first = reader.read()
        expect( first.text ).toBe( output.text )
        expect( calls ).toBe( 1 )

        now += 2_000
        reader.read()
        await settle()
        expect( reader.read() ).toBe( first )

        output = reply( { session_id: `new-root-session`, text: `New conversation` } )
        now += 2_000
        reader.read()
        await settle()
        expect( reader.read().text ).toBe( `New conversation` )

        output = reply( { turn_id: `turn-2`, text: `New final reply`, completed_at: `2026-09-07T12:01:00.000Z` } )
        now += 2_000
        reader.read()
        await settle()
        expect( reader.read().text ).toBe( `New final reply` )
        reader.close()
    } )

    it( `retains the last reply through missing, malformed, oversized and stale records`, async () => {
        let now = 0
        let output = JSON.stringify( reply() )
        const reader = create_completion_reader( session, {
            now_fn: () => now,
            run_command: async () => {
                if( output === null ) throw new Error( `Container unavailable` )
                return encode( output )
            },
        } )
        reader.read()
        await settle()
        const first = reader.read()
        for( const invalid of [
            null, `not JSON`, `x`.repeat( 1_024 * 1_024 + 1 ),
            JSON.stringify( reply( { version: 2 } ) ),
            JSON.stringify( reply( { launch_id: `another-launch` } ) ),
            JSON.stringify( reply( { agent: `claude` } ) ),
            JSON.stringify( reply( { text: `x`.repeat( 256 * 1_024 + 1 ) } ) ),
            JSON.stringify( reply( { text: `` } ) ),
            JSON.stringify( reply( { completed_at: `invalid` } ) ),
            JSON.stringify( reply( { completed_at: `2026-09-07T11:00:00.000Z` } ) ),
        ] ) {
            output = invalid
            now += 2_000
            reader.read()
            await settle()
            expect( reader.read() ).toBe( first )
        }
        reader.close()
    } )

    it( `has at most one read in flight and ignores late results after close`, async () => {
        let finish
        let calls = 0
        let now = 0
        const reader = create_completion_reader( session, {
            now_fn: () => now,
            run_command: () => {
                calls++
                return new Promise( resolve => { finish = resolve } )
            },
        } )
        reader.read()
        now += 10_000
        expect( reader.read() ).toBeNull()
        expect( calls ).toBe( 1 )
        reader.close()
        finish( encode( JSON.stringify( reply() ) ) )
        await settle()
        expect( reader.read() ).toBeNull()
        expect( calls ).toBe( 1 )
    } )

    it( `does not execute commands for legacy or invalid launch metadata`, () => {
        for( const invalid of [
            {}, { ...session, completion_capture: null },
            { ...session, completion_capture: { launch_id, file: `/etc/passwd` } },
            { ...session, container_id: `--privileged` },
        ] ) {
            const reader = create_completion_reader( invalid, {
                run_command: () => { throw new Error( `Unexpected Docker command` ) },
            } )
            expect( reader.read() ).toBeNull()
            reader.close()
        }
    } )

    it( `uses launch identity when the resumed agent starts a new native session`, async () => {
        const reader = create_completion_reader( { ...session, agent_session_id: `resumed-session` }, {
            run_command: async () => encode( JSON.stringify( reply() ) ),
        } )
        reader.read()
        await settle()
        expect( reader.read().session_id ).toBe( `native-session` )
        reader.close()
    } )

} )
