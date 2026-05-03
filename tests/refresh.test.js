import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
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

} )
