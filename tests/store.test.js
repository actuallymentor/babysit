import { acquire_session_lock } from '../src/sessions/lock.js'
import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
    generate_session_id,
    inspect_stored_sessions,
    load_session,
    save_session,
    session_original_workspace,
    session_workspace,
    sort_sessions_newest_first,
    update_session,
} from '../src/sessions/store.js'

const with_session_directory = test => {

    const directory = mkdtempSync( join( tmpdir(), `babysit-store-test-` ) )
    try {
        return test( directory )
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }

}

describe( `stored session ordering`, () => {

    it( `sorts session history newest first without mutating its input`, () => {

        const sessions = [
            { babysit_id: `older`, started_at: `2026-08-03T12:00:00.000Z` },
            { babysit_id: `legacy`, started_at: null },
            { babysit_id: `invalid`, started_at: `unknown` },
            { babysit_id: `newer`, started_at: `2026-08-04T12:00:00.000Z` },
        ]

        const sorted = sort_sessions_newest_first( sessions )

        expect( sorted.map( session => session.babysit_id ) ).toEqual( [ `newer`, `older`, `legacy`, `invalid` ] )
        expect( sessions.map( session => session.babysit_id ) ).toEqual( [ `older`, `legacy`, `invalid`, `newer` ] )

    } )

    it( `resolves duplicate native ids to the newest Babysit launch`, () => {

        const suffix = `${ process.pid }-${ Date.now() }`
        const native_id = `native-${ suffix }`
        const older_id = `store-test-older-${ suffix }`
        const newer_id = `store-test-newer-${ suffix }`
        with_session_directory( directory => {
            save_session( {
                babysit_id: older_id,
                agent: `codex`,
                agent_session_id: native_id,
                tmux_session: `older`,
                pwd: `/workspace/older`,
                modifiers: [],
                started_at: `2026-08-03T12:00:00.000Z`,
            }, { directory } )
            save_session( {
                babysit_id: newer_id,
                agent: `codex`,
                agent_session_id: native_id,
                tmux_session: `newer`,
                pwd: `/workspace/newer`,
                modifiers: [],
                started_at: `2026-08-04T12:00:00.000Z`,
            }, { directory } )

            expect( load_session( native_id, { directory } )?.babysit_id ).toBe( newer_id )
            expect( load_session( older_id, { directory } )?.babysit_id ).toBe( older_id )
        } )

    } )

} )

describe( `stored session persistence`, () => {

    it( `atomically saves and updates complete session records`, () => {

        const id = `store-test-atomic-${ process.pid }-${ Date.now() }`
        with_session_directory( directory => {
            const path = join( directory, `${ id }.json` )
            save_session( {
                babysit_id: id,
                agent: `codex`,
                tmux_session: `atomic`,
                pwd: `/workspace/original`,
                modifiers: [],
                started_at: `2026-09-03T12:00:00.000Z`,
            }, { directory } )
            update_session( id, {
                agent_session_id: `native-atomic`,
                clone_path: `/home/user/.babysit/clones/${ id }`,
            }, { directory } )

            expect( JSON.parse( readFileSync( path, `utf-8` ) ) ).toEqual( expect.objectContaining( {
                babysit_id: id,
                agent_session_id: `native-atomic`,
                clone_path: `/home/user/.babysit/clones/${ id }`,
            } ) )
            expect( readdirSync( directory ).filter( file => file.startsWith( `${ id }.json.pending-` ) ) ).toEqual( [] )
        } )

    } )

    it( `ignores a malformed direct session record`, () => {

        const id = `store-test-malformed-${ process.pid }-${ Date.now() }`
        with_session_directory( directory => {
            const path = join( directory, `${ id }.json` )
            writeFileSync( path, `{ incomplete`, `utf-8` )
            expect( load_session( id, { directory } ) ).toBeNull()
        } )

    } )

    it( `reports malformed records and retains valid record mtimes`, () => {

        with_session_directory( directory => {
            save_session( {
                babysit_id: `valid-session`,
                started_at: `2026-09-04T12:00:00.000Z`,
            }, { directory } )
            writeFileSync( join( directory, `broken.json` ), `{ incomplete`, `utf-8` )

            const inspected = inspect_stored_sessions( { directory } )

            expect( inspected.records ).toHaveLength( 1 )
            expect( inspected.records[0].session.babysit_id ).toBe( `valid-session` )
            expect( Date.parse( inspected.records[0].updated_at ) ).toBeNumber()
            expect( inspected.invalid_files ).toEqual( [ join( directory, `broken.json` ) ] )
        } )

    } )

    it( `rejects redirected and mismatched session records`, () => {

        with_session_directory( directory => {
            const external = join( directory, `external-session.data` )
            writeFileSync( external, JSON.stringify( { babysit_id: `redirected` } ) )
            symlinkSync( external, join( directory, `redirected.json` ) )
            writeFileSync(
                join( directory, `wrong-name.json` ),
                JSON.stringify( { babysit_id: `different-id` } )
            )

            const inspected = inspect_stored_sessions( { directory } )

            expect( inspected.records ).toEqual( [] )
            expect( inspected.invalid_files ).toHaveLength( 2 )
        } )

    } )

} )

describe( `stored session ids`, () => {

    it( `uses a timestamp plus a high-entropy hexadecimal suffix`, () => {

        const ids = Array.from( { length: 100 }, generate_session_id )

        expect( ids.every( id => /^\d{8}-\d{6}-[a-f0-9]{12}$/.test( id ) ) ).toBeTrue()
        expect( new Set( ids ).size ).toBe( ids.length )

    } )

} )

describe( `stored session workspaces`, () => {

    it( `uses explicit clone metadata when present`, () => {

        const session = {
            pwd: `/workspace/legacy`,
            original_pwd: `/projects/original`,
            clone_path: `/home/user/.babysit/clones/session-id`,
        }

        expect( session_original_workspace( session ) ).toBe( `/projects/original` )
        expect( session_workspace( session ) ).toBe( `/home/user/.babysit/clones/session-id` )

    } )

    it( `falls back to legacy pwd metadata`, () => {

        const session = { pwd: `/projects/legacy` }

        expect( session_original_workspace( session ) ).toBe( `/projects/legacy` )
        expect( session_workspace( session ) ).toBe( `/projects/legacy` )
        expect( session_original_workspace() ).toBeNull()
        expect( session_workspace() ).toBeNull()
        expect( session_original_workspace( null ) ).toBeNull()
        expect( session_workspace( null ) ).toBeNull()

    } )

} )

describe( `durable lifecycle locks`, () => {

    it( `excludes concurrent owners and permits record writes while lifecycle work runs`, () => {

        with_session_directory( directory => {
            const release = acquire_session_lock( `codex:/workspace`, { directory } )
            expect( () => acquire_session_lock( `codex:/workspace`, { directory } ) ).toThrow( `already in progress` )
            save_session( { babysit_id: `session`, expected_open: true }, { directory } )
            update_session( `session`, { expected_open: false }, { directory } )
            expect( load_session( `session`, { directory } ).expected_open ).toBe( false )
            release()
            release()
            acquire_session_lock( `codex:/workspace`, { directory } )()
        } )

    } )

    it( `reclaims a previous boot despite a reused live PID`, () => {

        with_session_directory( directory => {
            const release = acquire_session_lock( `reboot`, { directory } )
            const owner_path = join( release.path, readdirSync( release.path )[ 0 ] )
            const owner = JSON.parse( readFileSync( owner_path, `utf8` ) )
            owner.boot_id = `previous-boot`
            writeFileSync( owner_path, JSON.stringify( owner ) )
            const recovered = acquire_session_lock( `reboot`, { directory } )
            release()
            expect( () => acquire_session_lock( `reboot`, { directory } ) ).toThrow( `already in progress` )
            recovered()
        } )

    } )

    it( `fails closed on unknown ownership`, () => {

        with_session_directory( directory => {
            const release = acquire_session_lock( `unknown`, { directory } )
            const owner_path = join( release.path, readdirSync( release.path )[ 0 ] )
            writeFileSync( owner_path, `{ broken` )
            expect( () => acquire_session_lock( `unknown`, { directory } ) ).toThrow( `already in progress` )
            release()
        } )

    } )

    it( `recovers a lock held by a process killed without cleanup`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-lock-killed-` ) )
        const lock_url = new URL( `../src/sessions/lock.js`, import.meta.url ).href
        const child = Bun.spawn( [ process.execPath, `--eval`,
            `import { acquire_session_lock } from ${ JSON.stringify( lock_url ) }; acquire_session_lock('killed', { directory: ${ JSON.stringify( directory ) } }); console.log('locked'); setInterval(() => {}, 1000)`,
        ], { stdout: `pipe`, stderr: `pipe` } )
        try {
            const reader = child.stdout.getReader()
            const { value } = await reader.read()
            expect( new TextDecoder().decode( value ) ).toContain( `locked` )
            expect( () => acquire_session_lock( `killed`, { directory } ) ).toThrow( `already in progress` )
            child.kill( `SIGKILL` )
            await child.exited
            acquire_session_lock( `killed`, { directory } )()
        } finally {
            child.kill()
            await child.exited
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

    // Eight processes perform 160 fsynced writes; allow slow test-host storage.
    it( `serializes concurrent process updates without losing fields`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-store-concurrent-` ) )
        try {
            save_session( { babysit_id: `concurrent`, expected_open: true }, { directory } )
            const store_url = new URL( `../src/sessions/store.js`, import.meta.url ).href
            const children = Array.from( { length: 8 }, ( _, index ) => Bun.spawn( [
                process.execPath, `--eval`,
                `import { update_session } from ${ JSON.stringify( store_url ) }; for(let i=0;i<20;i++) update_session('concurrent', { worker_${ index }: i }, { directory: ${ JSON.stringify( directory ) } })`,
            ], { stdout: `pipe`, stderr: `pipe` } ) )
            expect( await Promise.all( children.map( child => child.exited ) ) ).toEqual( Array( 8 ).fill( 0 ) )
            const record = load_session( `concurrent`, { directory } )
            for( let index = 0; index < 8; index++ ) expect( record[ `worker_${ index }` ] ).toBe( 19 )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    }, 15_000 )

} )
