import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { get_agent } from '../src/agents/index.js'
import { acquire_host_auth_lease } from '../src/agents/auth_lease.js'
import { resolve_claude_login } from '../src/cli/claude_accounts.js'
import { acquire_credentials, create_launch_transaction } from '../src/cli/start.js'
import { ACCOUNT_ENV_BOOTSTRAP_PATH, build_docker_launch_plan } from '../src/docker/launch.js'
import { cleanup_ephemeral_credential_mounts } from '../src/credentials/index.js'

const TOKEN = `sk-ant-oat01-nested_token-1`
const codex = get_agent( `codex` )

// A JWT whose payload only carries exp
const jwt = exp_ms => `h.${ Buffer.from( JSON.stringify( { exp: exp_ms / 1_000 } ) ).toString( `base64url` ) }.s`

let dir
beforeEach( () => {
    dir = mkdtempSync( join( tmpdir(), `babysit-launch-phases-` ) )
} )
afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

// A launch context as resolve_launch would leave it, minus Docker and tmux
const launch_for = ( agent, overrides = {} ) => ( {
    agent,
    cmd: {},
    mode: {},
    passthrough: [],
    workspace: dir,
    claude_login: { mounts: [], route: null },
    transaction: create_launch_transaction( { babysit_id: `phase-test`, mark_failed: () => {} } ),
    ...overrides,
} )

const lease_path = () => join( dir, `lease` )

// Capture-only seams: no real host files, recovery registry, or auth cache
const seams = ( setup, extra = {} ) => ( {
    acquire_lease: options => acquire_host_auth_lease( { ...options, lease_path: lease_path(), poll_ms: 5 } ),
    setup,
    register_recovery: () => null,
    cache_contexts: async () => ( {} ),
    ...extra,
} )

const codex_file = content => {
    const source = join( dir, `codex-auth.json` )
    writeFileSync( source, content )
    return { mounts: [ { type: `synced_file`, source, target: codex.container_paths.creds } ], sync: null, states: {}, tmpfiles: {} }
}

describe( `launch phases: acquire_credentials`, () => {

    it( `stages the chosen Claude setup-token for nested claude in a codex session`, async () => {

        const claude_login = await resolve_claude_login( { probe_quota: false }, {
            list: () => [ { name: `default`, token: TOKEN } ],
            route: () => null,
            probe: async () => {
                throw new Error( `a codex launch must not probe Claude quota` )
            },
        } )
        const launch = launch_for( codex, { claude_login } )
        await acquire_credentials( launch, seams( async () => codex_file( JSON.stringify( { tokens: { access_token: jwt( Date.now() + 3_600_000 ) } } ) ) ) )

        const keys = launch.credentials.mounts.filter( mount => mount.type === `account_env` ).map( mount => mount.key )
        expect( keys ).toEqual( [ `CLAUDE_CODE_OAUTH_TOKEN`, `BABYSIT_CLAUDE_HOT_SWAP` ] )

        // The token reaches the codex container only as the private account env file
        const plan = build_docker_launch_plan( { agent: codex, creds_mounts: launch.credentials.mounts, mode: {}, extra_mounts: [], workspace: dir } )
        const account_file = plan.creds_mounts.find( mount => mount.target === ACCOUNT_ENV_BOOTSTRAP_PATH )
        expect( readFileSync( account_file.source, `utf-8` ) ).toBe( `CLAUDE_CODE_OAUTH_TOKEN=${ TOKEN }\nBABYSIT_CLAUDE_HOT_SWAP=1\n` )
        expect( plan.creds_mounts.some( mount => mount.type === `env` && mount.value === TOKEN ) ).toBe( false )
        cleanup_ephemeral_credential_mounts( plan.creds_mounts )

    } )

    it( `starts a Codex login whose access token expired but can refresh, without asking`, async () => {

        const launch = launch_for( codex )
        await acquire_credentials( launch, seams(
            async () => codex_file( JSON.stringify( { tokens: { access_token: jwt( Date.now() - 3_600_000 ), refresh_token: `r` } } ) ),
            { confirm: async () => {
                throw new Error( `refreshable must not ask` )
            } },
        ) )

        expect( launch.credentials.mounts ).toHaveLength( 1 )

    } )

    it( `asks before a launch with no login, and a batch launch aborts as an authentication abort`, async () => {

        const asked = []
        const empty = async () => ( { mounts: [], sync: null, states: {}, tmpfiles: {} } )

        await acquire_credentials( launch_for( codex ), seams( empty, { confirm: async names => asked.push( names ) && true } ) )
        expect( asked ).toEqual( [ [ `codex` ] ] )

        const batch = launch_for( codex, { cmd: { batch: true } } )
        await expect( acquire_credentials( batch, seams( empty ) ) ).rejects.toThrow( /launch aborted/ )
        expect( batch.transaction.context ).toBe( `authentication abort` )

    } )

    it( `waits for a concurrent probe's lease, so it captures the token that probe rotated`, async () => {

        const host = join( dir, `host-auth.json` )
        writeFileSync( host, `{"refresh_token":"before-probe"}` )

        // A doctor/checker probe holds the lease while it rotates the one-use token
        const probe = await acquire_host_auth_lease( { lease_path: lease_path() } )
        const launch = launch_for( codex )
        const capturing = acquire_credentials( launch, seams( async () => {
            const source = join( dir, `captured.json` )
            writeFileSync( source, readFileSync( host, `utf-8` ) )
            return { mounts: [ { type: `synced_file`, source, target: codex.container_paths.creds } ], sync: null, states: {}, tmpfiles: {} }
        }, { gate: () => `usable` } ) )

        await new Promise( resolve => setTimeout( resolve, 50 ) )
        expect( launch.credentials ).toBeUndefined()
        writeFileSync( host, `{"refresh_token":"after-probe"}` )
        probe.release()
        await capturing

        expect( readFileSync( launch.credentials.mounts[0].source, `utf-8` ) ).toBe( `{"refresh_token":"after-probe"}` )
        // The launch released the lease after capture
        expect( existsSync( lease_path() ) ).toBe( false )

    } )

} )

describe( `launch transaction`, () => {

    it( `retains the stopped container and private sync state when the final flush fails`, async () => {

        const calls = []
        const transaction = create_launch_transaction( {
            babysit_id: `retain-test`,
            release_clone_lock: () => calls.push( `release clone lock` ),
            mark_failed: () => calls.push( `mark failed` ),
        } )
        transaction.context = `launch failure`
        transaction.recovery_id = `kept-marker`
        transaction.creds_sync = {
            stop: async () => {
                throw new Error( `docker cp failed` )
            },
            cleanup: () => calls.push( `cleanup credentials` ),
        }
        transaction.prepared_launch = {
            retain: async ( { stop } ) => calls.push( `retain stop=${ stop }` ) && `container-1`,
            abort: async () => calls.push( `abort` ),
        }

        const result = await transaction.fail( new Error( `boom` ) )
        // A second failure path reuses the first teardown
        await transaction.fail( new Error( `again` ) )

        expect( result ).toMatchObject( { cleaned: false, retained_container: `container-1` } )
        expect( calls ).toEqual( [ `retain stop=true`, `mark failed`, `release clone lock` ] )

    } )

    it( `cleans copies, states and the container when the final flush succeeds`, async () => {

        const calls = []
        const transaction = create_launch_transaction( {
            babysit_id: `clean-test`,
            mark_failed: () => calls.push( `mark failed` ),
            cleanup: async options => calls.push( `cleanup ${ options.context }` ),
        } )
        transaction.context = `startup failure`
        transaction.after_failure.push( () => calls.push( `remove diagnostics` ) )

        await transaction.fail( new Error( `boom` ) )
        expect( calls ).toEqual( [ `cleanup startup failure`, `remove diagnostics`, `mark failed` ] )

    } )

} )
