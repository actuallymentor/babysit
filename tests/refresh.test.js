import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync, unlinkSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { hash_credential_content, start_credential_sync } from '../src/credentials/refresh.js'

// stop() runs one final tick — the test surface for the bidirectional sync
// without having to wait the full REFRESH_INTERVAL_MS for a periodic tick.

describe( `start_credential_sync`, () => {

    let dir
    let host_path
    let tmpfile_path

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-refresh-` ) )
        host_path = join( dir, `auth.json` )
        tmpfile_path = join( dir, `tmpfile-creds` )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `pushes container-side updates back to the host source on stop`, async () => {

        // Initial: host and tmpfile both hold the original token state
        writeFileSync( host_path, `{"refresh_token":"X"}` )
        writeFileSync( tmpfile_path, `{"refresh_token":"X"}` )

        const read_source = async () => readFileSync( host_path, `utf-8` )
        const write_destination = async ( content ) => {
            writeFileSync( host_path, content )
        }

        const sync = start_credential_sync( read_source, tmpfile_path, write_destination )

        // Container's agent refreshes the token — tmpfile now holds Y
        writeFileSync( tmpfile_path, `{"refresh_token":"Y"}` )

        // Final flush should propagate Y back to host
        await sync.stop()

        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"refresh_token":"Y"}` )

    } )

    it( `notifies pull listeners only after a rotated credential reached the host`, async () => {

        writeFileSync( host_path, `{"refresh_token":"X"}` )
        writeFileSync( tmpfile_path, `{"refresh_token":"X"}` )
        const pulls = []
        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path,
            async content => writeFileSync( host_path, content )
        )
        sync.on_pull( () => pulls.push( readFileSync( host_path, `utf-8` ) ) )

        await sync.flush()
        expect( pulls ).toEqual( [] )

        writeFileSync( tmpfile_path, `{"refresh_token":"Y"}` )
        await sync.stop()
        expect( pulls ).toEqual( [ `{"refresh_token":"Y"}` ] )

    } )

    it( `does not write back when no write_destination is provided (one-way mode)`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const read_source = async () => readFileSync( host_path, `utf-8` )

        const sync = start_credential_sync( read_source, tmpfile_path )

        writeFileSync( tmpfile_path, `{"token":"Y"}` )
        await sync.stop()

        // Host stays at X — no write_destination, so tmpfile-side changes are ignored
        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"X"}` )

    } )

    it( `prefers source on conflict (host re-auth wins over container refresh)`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const read_source = async () => readFileSync( host_path, `utf-8` )
        const write_destination = async ( content ) => {
            writeFileSync( host_path, content )
        }

        const sync = start_credential_sync( read_source, tmpfile_path, write_destination )

        // Both sides changed since the initial seed:
        //   - Host re-authed  → Z
        //   - Container refreshed → Y
        // Source-wins policy: tmpfile gets overwritten with Z, host stays Z.
        writeFileSync( host_path, `{"token":"Z"}` )
        writeFileSync( tmpfile_path, `{"token":"Y"}` )

        await sync.stop()

        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"Z"}` )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( `{"token":"Z"}` )

    } )

    it( `uses the foreground baseline when the tmpfile rotated before monitor sync starts`, async () => {

        writeFileSync( host_path, `{"refresh_token":"X"}` )
        writeFileSync( tmpfile_path, `{"refresh_token":"X"}` )

        const initial_hash = hash_credential_content( `{"refresh_token":"X"}` )

        // Codex can refresh immediately during startup, before the detached
        // monitor has established its sync. The monitor must compare against
        // the foreground capture hash, not seed from the already-rotated
        // tmpfile, or stale host state would overwrite the valid refresh.
        writeFileSync( tmpfile_path, `{"refresh_token":"Y"}` )

        const read_source = async () => readFileSync( host_path, `utf-8` )
        const write_destination = async ( content ) => {
            writeFileSync( host_path, content )
        }

        const sync = start_credential_sync( read_source, tmpfile_path, write_destination, {
            baseline_source_hash: initial_hash,
            baseline_tmpfile_hash: initial_hash,
        } )

        await sync.stop()

        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"refresh_token":"Y"}` )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( `{"refresh_token":"Y"}` )

    } )

    it( `is a no-op when nothing changed`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const read_source = async () => readFileSync( host_path, `utf-8` )

        let writes = 0
        const write_destination = async ( content ) => {
            writes++
            writeFileSync( host_path, content )
        }

        const sync = start_credential_sync( read_source, tmpfile_path, write_destination )
        await sync.stop()

        expect( writes ).toBe( 0 )
        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"X"}` )

    } )

    it( `pulls Docker-staged credential rotations before writing the host`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path,
            async content => writeFileSync( host_path, content )
        )

        sync.set_transport( {
            pull: async path => writeFileSync( path, `{"token":"Y"}` ),
            push: async () => {
                throw new Error( `unexpected push` )
            },
        } )

        await sync.stop()

        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"Y"}` )

    } )

    it( `pushes a deliberate host reauthentication before pulling container state`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path
        )
        const calls = []

        sync.set_transport( {
            pull: async () => calls.push( `pull` ),
            push: async path => calls.push( `push:${ readFileSync( path, `utf-8` ) }` ),
        } )

        writeFileSync( host_path, `{"token":"Z"}` )
        await sync.stop()

        expect( calls ).toEqual( [ `push:{"token":"Z"}` ] )

    } )

    it( `preserves a host reauthentication that happens during a Docker pull`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const pushes = []
        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path,
            async content => writeFileSync( host_path, content )
        )

        sync.set_transport( {
            pull: async path => {
                writeFileSync( host_path, `{"token":"Z"}` )
                await Promise.resolve()
                writeFileSync( path, `{"token":"Y"}` )
            },
            push: async path => pushes.push( readFileSync( path, `utf-8` ) ),
        } )

        await sync.stop()

        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"Z"}` )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( `{"token":"Z"}` )
        expect( pushes ).toEqual( [ `{"token":"Z"}` ] )

    } )

    it( `serializes overlapping final sync requests`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        let active_pulls = 0
        let max_active_pulls = 0
        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path
        )

        sync.set_transport( {
            pull: async () => {
                active_pulls += 1
                max_active_pulls = Math.max( max_active_pulls, active_pulls )
                await new Promise( resolve => setTimeout( resolve, 2 ) )
                active_pulls -= 1
            },
            push: async () => {},
        } )

        await Promise.all( [ sync.stop(), sync.stop() ] )

        expect( max_active_pulls ).toBe( 1 )

    } )

    it( `propagates a failed final Docker pull so recovery copies can be retained`, async () => {

        writeFileSync( host_path, `{"token":"X"}` )
        writeFileSync( tmpfile_path, `{"token":"X"}` )

        const sync = start_credential_sync(
            async () => readFileSync( host_path, `utf-8` ),
            tmpfile_path,
            async content => writeFileSync( host_path, content )
        )
        sync.set_transport( {
            pull: async () => {
                throw new Error( `temporary docker failure` )
            },
            push: async () => {},
        } )

        await expect( sync.stop() ).rejects.toThrow( `temporary docker failure` )
        expect( readFileSync( host_path, `utf-8` ) ).toBe( `{"token":"X"}` )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( `{"token":"X"}` )

    } )

} )

describe( `host credential watcher`, () => {

    let dir, host_path, tmpfile_path, sync, container_content, pushes, pulls
    const original = `{"token":"original"}`
    const renewed = `{"token":"renewed"}`
    const wait = ms => new Promise( resolve => setTimeout( resolve, ms ) )
    const until = async predicate => {
        const deadline = Date.now() + 3_000
        while( !predicate() && Date.now() < deadline ) await wait( 20 )
        expect( predicate() ).toBe( true )
    }

    const replace_host = content => {
        const replacement = join( dir, `replacement` )
        writeFileSync( replacement, content )
        renameSync( replacement, host_path )
    }

    const transport = () => ( {
        push: async path => {
            container_content = readFileSync( path, `utf-8` )
            pushes.push( container_content )
        },
        pull: async path => {
            pulls += 1
            writeFileSync( path, container_content )
        },
    } )

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-watch-` ) )
        host_path = join( dir, `auth.json` )
        tmpfile_path = join( dir, `staged.json` )
        writeFileSync( host_path, original )
        writeFileSync( tmpfile_path, original )
        container_content = original
        pushes = []
        pulls = 0
        sync = start_credential_sync(
            async () => {
                try { return readFileSync( host_path, `utf-8` ) } catch { return null }
            },
            tmpfile_path,
            async content => writeFileSync( host_path, content ),
            { source_path: host_path }
        )
    } )

    afterEach( async () => {
        try { await sync.stop() } finally { rmSync( dir, { recursive: true, force: true } ) }
    } )

    it( `observes repeated atomic replacements without a flush or restart`, async () => {
        sync.set_transport( transport() )
        replace_host( renewed )
        await until( () => container_content === renewed )
        replace_host( original )
        await until( () => container_content === original )
        expect( pushes ).toEqual( [ renewed, original ] )
        expect( pulls ).toBe( 0 )
    } )

    it( `ignores duplicate content, unrelated files, and its own host writeback`, async () => {
        sync.set_transport( transport() )
        await wait( 30 )
        writeFileSync( join( dir, `config.toml` ), `unrelated` )
        replace_host( original )
        await wait( 350 )
        expect( pushes ).toEqual( [] )
        expect( pulls ).toBe( 0 )

        container_content = renewed
        await sync.flush()
        await wait( 350 )
        expect( readFileSync( host_path, `utf-8` ) ).toBe( renewed )
        expect( pushes ).toEqual( [] )
        expect( pulls ).toBe( 1 )
    } )

    it( `retains state through partial writes and deletion, then syncs the completed login`, async () => {
        sync.set_transport( transport() )
        await wait( 30 )
        writeFileSync( host_path, `{"token":` )
        await wait( 350 )
        await expect( sync.flush() ).rejects.toThrow( `missing or incomplete` )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( original )
        unlinkSync( host_path )
        await wait( 350 )
        expect( pushes ).toEqual( [] )
        expect( pulls ).toBe( 0 )
        replace_host( renewed )
        await until( () => container_content === renewed )
    } )

    it( `catches changes before connection without advancing the staged baseline`, async () => {
        replace_host( renewed )
        await wait( 350 )
        expect( readFileSync( tmpfile_path, `utf-8` ) ).toBe( original )
        sync.set_transport( transport() )
        await until( () => container_content === renewed )
    } )

    it( `serializes a host replacement during a container pull`, async () => {
        let release_pull
        let pulling = false
        const pull_gate = new Promise( resolve => { release_pull = resolve } )
        const connected = transport()
        sync.set_transport( {
            ...connected,
            pull: async path => {
                pulling = true
                await pull_gate
                await connected.pull( path )
                pulling = false
            },
            push: async path => {
                expect( pulling ).toBe( false )
                await connected.push( path )
            },
        } )
        const flush = sync.flush()
        await until( () => pulling )
        replace_host( renewed )
        await wait( 350 )
        expect( pushes ).toEqual( [] )
        release_pull()
        await flush
        await until( () => container_content === renewed )
        expect( readFileSync( host_path, `utf-8` ) ).toBe( renewed )
        expect( pushes ).toEqual( [ renewed ] )
    } )

    it( `flushes a pending login on stop and closes the watcher`, async () => {
        sync.set_transport( transport() )
        await wait( 30 )
        replace_host( renewed )
        await sync.stop()
        expect( container_content ).toBe( renewed )
        replace_host( original )
        const calls = pushes.length + pulls
        await wait( 350 )
        expect( pushes.length + pulls ).toBe( calls )
    } )

    it( `retries a failed push without consuming the new host credential`, async () => {
        const connected = transport()
        let attempts = 0
        sync.set_transport( {
            ...connected,
            push: async path => {
                attempts += 1
                if( attempts === 1 ) throw new Error( `Docker unavailable` )
                await connected.push( path )
            },
        } )
        replace_host( renewed )
        await until( () => attempts === 1 )
        expect( container_content ).toBe( original )
        expect( sync.baseline().baseline_source_hash ).toBe( hash_credential_content( original ) )

        // The periodic and explicit fallback use this same queue.
        await sync.flush()
        expect( container_content ).toBe( renewed )
        expect( pulls ).toBe( 0 )
    } )

    it( `does not resurrect a host logout or fail final cleanup`, async () => {
        sync.set_transport( transport() )
        unlinkSync( host_path )
        await sync.flush()
        expect( sync.baseline().baseline_source_hash ).toBeNull()
        expect( sync.source_changed() ).toBe( true )
        await sync.stop()
        expect( existsSync( host_path ) ).toBe( false )
        expect( pulls ).toBe( 0 )
        expect( pushes ).toEqual( [] )
    } )

    it( `respects logout during a pull and observes a restored login`, async () => {
        const connected = transport()
        sync.set_transport( {
            ...connected,
            pull: async path => {
                unlinkSync( host_path )
                container_content = renewed
                await connected.pull( path )
            },
        } )
        await sync.flush()
        expect( existsSync( host_path ) ).toBe( false )
        replace_host( original )
        await until( () => container_content === original )
        // Restore the normal pull for final cleanup.
        sync.set_transport( connected )
    } )

} )
