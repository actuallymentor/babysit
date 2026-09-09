import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { recover_session, cmd_recover, close_session } from '../src/cli/recover.js'
import { record_launch_progress } from '../src/cli/start.js'
import { continue_recovered_session } from '../src/sessions/continuation.js'
import { save_session, load_session, update_session, inspect_stored_sessions } from '../src/sessions/store.js'
import { get_boot_id, get_process_identity } from '../src/sessions/lock.js'
import { workspace_config_hash } from '../src/sessions/recovery.js'

const cleanups = []
afterEach( () => cleanups.splice( 0 ).reverse().forEach( cleanup => cleanup() ) )

const fixture = () => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-recovery-race-` ) )
    cleanups.push( () => rmSync( directory, { recursive: true, force: true } ) )
    const store = { directory: join( directory, `sessions` ) }
    writeFileSync( join( directory, `babysit.yaml` ), `config: {}\nbabysit: []\n` )
    const session = {
        babysit_id: `launch`, agent: `codex`, pwd: directory, host: hostname(),
        recovery_version: 1, expected_open: true, agent_session_id: `native`, agent_session_id_source: `structured`,
        status: `active`, boot_id: get_boot_id(), docker_id: `daemon`, tmux_session: `pane`, pane_id: `%1`,
        monitor_token: `token`, container_id: `container`, image_id: `sha256:${ `a`.repeat( 64 ) }`,
        launch_spec: { args: [], config_hash: workspace_config_hash( directory ) },
    }
    save_session( session, store )
    const calls = []
    const load = id => load_session( id, store )
    const update = ( id, fields ) => {
        calls.push( `update` )
        return update_session( id, fields, store )
    }
    const dependencies = {
        load, update,
        lock: () => () => {},
        sessions: async () => [],
        pane: async () => ( { pane_id: `%1` } ),
        monitor_alive: () => false,
        inspect: async () => { calls.push( `inspect` ); return null },
        identity: async () => ( { docker_id: `daemon` } ),
        durable_exit: async () => null,
        durable_identity: async () => { calls.push( `identity` ); return null },
        verify: async () => { calls.push( `verify` ) },
        reconcile: async () => { calls.push( `reconcile` ) },
        start: async () => { calls.push( `start` ); return { babysit_id: `resumed` } },
        wait_continuation: async () => ( { continuation: `sent` } ),
    }
    return { directory, store, session, calls, load, update, dependencies }
}

const receipt = ( interrupted = false ) => ( { exit_status: 0, interrupted, exited_at: `2026-09-09T12:00:00Z` } )

describe( `recovery lifecycle races`, () => {

    it( `does not submit when --no-continue wins during the awaited pane lookup`, async () => {
        const f = fixture()
        f.update( `launch`, { continuation: `pending` } )
        const original = f.load( `launch` )
        const sent = []
        let acknowledged
        const outcome = await continue_recovered_session( original, {
            load: f.load, update: f.update,
            ready: async () => true,
            read_identity: async () => ( { session_id: `native` } ),
            pane: async () => {
                // The monitor already read "pending". A concurrent CLI wins
                // while tmux lookup yields, before the monitor claims input.
                acknowledged = await recover_session( f.load( `launch` ), { no_continue: true }, {
                    ...f.dependencies,
                    sessions: async () => [ { name: `pane` } ],
                    inspect: async () => `running`,
                    monitor_alive: () => true,
                } )
                return { pane_id: `%1` }
            },
            send: async ( ...args ) => sent.push( args ),
        } )
        expect( acknowledged.status ).toBe( `active` )
        expect( outcome ).toBe( `skipped` )
        expect( f.load( `launch` ).continuation ).toBe( `skipped` )
        expect( sent ).toEqual( [] )
    } )

    it( `preserves --no-continue when the in-flight pane lookup rejects`, async () => {
        const f = fixture()
        f.update( `launch`, { continuation: `pending` } )
        const original = f.load( `launch` )
        let sends = 0
        const result = await continue_recovered_session( original, {
            load: f.load, update: f.update,
            ready: async () => true,
            read_identity: async () => ( { session_id: `native` } ),
            pane: async () => {
                f.update( `launch`, { continuation: `skipped` } )
                throw new Error( `Tmux connection closed after acknowledgement` )
            },
            send: async () => { sends++ },
        } )
        expect( result ).toBe( `skipped` )
        expect( f.load( `launch` ).continuation ).toBe( `skipped` )
        expect( sends ).toBe( 0 )
    } )

    it( `rejects manual close of a live preparing launch without changing intent`, async () => {
        const f = fixture()
        f.update( `launch`, { status: `preparing`, launch_owner: { pid: process.pid, process_identity: get_process_identity(), boot_id: get_boot_id(), hostname: hostname() } } )
        const before = f.load( `launch` )
        await expect( close_session( before, {}, { load: f.load, update: f.update, lock: () => () => {} } ) ).rejects.toThrow( `launch is still in progress` )
        expect( f.load( `launch` ) ).toEqual( before )
    } )

    it( `retains preparing shutdown intent through stale progress and failure writes`, async () => {
        const f = fixture()
        f.update( `launch`, { status: `preparing`, launch_owner: { pid: process.pid, process_identity: get_process_identity(), boot_id: get_boot_id(), hostname: hostname() } } )
        const stale = f.load( `launch` )
        await close_session( stale, { shutdown: true }, { load: f.load, update: f.update, lock: () => () => {} } )
        record_launch_progress( `launch`, { ...stale, status: `active` }, { update: f.update } )
        expect( f.load( `launch` ) ).toMatchObject( { expected_open: true, shutdown_boot_id: get_boot_id() } )
        record_launch_progress( `launch`, { status: `failed` }, { update: f.update } )
        expect( f.load( `launch` ).expected_open ).toBe( true )
    } )

    it( `never reopens explicit closure during stale handoff or recovery failure`, () => {
        const f = fixture()
        const stale = f.load( `launch` )
        f.update( `launch`, { expected_open: false, close_reason: `user` } )
        record_launch_progress( `launch`, stale, { update: f.update } )
        expect( f.load( `launch` ).expected_open ).toBe( false )
        record_launch_progress( `launch`, { status: `failed` }, { recovering: true, update: f.update } )
        expect( f.load( `launch` ).expected_open ).toBe( false )
        expect( f.load( `launch` ).close_reason ).toBe( `user` )
    } )

    it( `reports a durable clean exit in dry-run without touching registry or containers`, async () => {
        const f = fixture()
        const path = join( f.store.directory, `launch.json` )
        const before = readFileSync( path )
        const result = await recover_session( f.session, { dry_run: true }, { ...f.dependencies, durable_exit: async () => receipt() } )
        expect( result.status ).toBe( `closed` )
        expect( readFileSync( path ) ).toEqual( before )
        expect( f.calls ).toEqual( [] )
    } )

    it( `reconciles the stopped container before retiring a durable clean exit`, async () => {
        const f = fixture()
        const result = await recover_session( f.session, {}, { ...f.dependencies, durable_exit: async () => receipt() } )
        expect( result.status ).toBe( `closed` )
        expect( f.calls ).toEqual( [ `reconcile`, `inspect`, `update` ] )
        expect( f.load( `launch` ) ).toMatchObject( { expected_open: false, close_reason: `agent_exit`, closed_at: receipt().exited_at } )
    } )

    it( `preserves recovery intent when clean-exit credential reconciliation fails`, async () => {
        const f = fixture()
        await expect( recover_session( f.session, {}, {
            ...f.dependencies, durable_exit: async () => receipt(),
            reconcile: async () => { throw new Error( `Credentials remain unsynced` ) },
        } ) ).rejects.toThrow( `Credentials remain unsynced` )
        expect( f.load( `launch` ).expected_open ).toBe( true )
        expect( f.calls ).toEqual( [] )
    } )

    it( `recovers an interrupted native zero exit instead of retiring it`, async () => {
        const f = fixture()
        const result = await recover_session( f.session, {}, { ...f.dependencies, durable_exit: async () => receipt( true ) } )
        expect( result.status ).toBe( `recovered` )
        expect( f.calls ).toContain( `start` )
        expect( f.load( `launch` ).close_reason ).toBeUndefined()
    } )

    it( `closes a previously clean native exit even when shutdown stamped it later`, async () => {
        const f = fixture()
        f.update( `launch`, { shutdown_boot_id: f.session.boot_id } )
        const result = await recover_session( f.load( `launch` ), {}, { ...f.dependencies, durable_exit: async () => receipt() } )
        expect( result.status ).toBe( `closed` )
        expect( f.load( `launch` ).expected_open ).toBe( false )
        expect( f.calls ).not.toContain( `start` )
    } )

    it( `keeps a shutdown-interrupted zero exit recoverable`, async () => {
        const f = fixture()
        f.update( `launch`, { shutdown_boot_id: f.session.boot_id } )
        const result = await recover_session( f.load( `launch` ), {}, { ...f.dependencies, durable_exit: async () => receipt( true ) } )
        expect( result.status ).toBe( `recovered` )
        expect( f.calls ).toContain( `start` )
    } )

    it( `follows persisted replacement launches on bounded boot retries`, async () => {
        const f = fixture()
        const attempted = []
        const delays = []
        const results = await cmd_recover( { flags: { boot: true } }, {
            inspect: () => inspect_stored_sessions( f.store ),
            load: f.load,
            wait_fn: async ms => { delays.push( ms ) },
            recover: async session => {
                attempted.push( session.babysit_id )
                if( attempted.length === 3 ) return { id: session.babysit_id, status: `recovered` }
                const next = `attempt-${ attempted.length }`
                save_session( { ...session, babysit_id: next, resumed_from: session.babysit_id, expected_open: true }, f.store )
                f.update( session.babysit_id, { superseded_by: next, expected_open: false } )
                throw new Error( `Temporary Docker failure after replacement was saved` )
            },
        } )
        expect( attempted ).toEqual( [ `launch`, `attempt-1`, `attempt-2` ] )
        expect( delays ).toEqual( [ 5_000, 10_000 ] )
        expect( results ).toEqual( [ { id: `attempt-2`, status: `recovered` } ] )
    } )

} )
