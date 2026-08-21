import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import {
    fingerprint_agent_credentials,
    read_host_auth_cache,
    record_host_auth_success,
} from '../src/agents/auth_cache.js'
import { get_agent, SUPPORTED_AGENTS } from '../src/agents/index.js'
import { cmd_doctor, select_doctor_auth_agents } from '../src/cli/doctor.js'

const IMAGE_IDENTITY = `sha256:doctor-test-image`
const WITHOUT_HOST_CONTEXT = { resolve_context_files: () => ( {} ) }

const command = ( {
    agent = `codex`,
    auth = true,
    refresh = false,
} = {} ) => ( {
    auth_agent: agent,
    flags: { auth, refresh },
} )

const collect_io = () => {

    const input = new PassThrough()
    const output = new PassThrough()
    let rendered = ``

    input.isTTY = false
    output.isTTY = false
    output.on( `data`, chunk => rendered += chunk.toString() )

    return { input, output, rendered: () => rendered }

}

const setup_result = ( mounts, sync = null ) => async () => ( {
    mounts,
    sync,
    tmpfiles: {},
} )

describe( `doctor authentication diagnostics`, () => {

    let directory
    let cache_path
    let mounts

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-doctor-` ) )
        cache_path = join( directory, `auth-cache.json` )
        mounts = [ {
            type: `secret_env`,
            key: `CODEX_API_KEY`,
            value: `doctor-test-key`,
        } ]
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `selects all agents by default, one named agent explicitly, and rejects unknown agents`, () => {

        expect( select_doctor_auth_agents().map( agent => agent.name ) ).toEqual( SUPPORTED_AGENTS )
        expect( select_doctor_auth_agents( `opencode` ).map( agent => agent.name ) ).toEqual( [ `opencode` ] )
        expect( () => select_doctor_auth_agents( `unknown` ) ).toThrow(
            /Unsupported doctor authentication agent: unknown/
        )

    } )

    it( `requires an explicit authentication diagnostic`, async () => {

        let setup_called = false

        await expect( cmd_doctor( command( { auth: false } ), {
            setup: async () => {
                setup_called = true
            },
        } ) ).rejects.toThrow( /babysit doctor --auth/ )

        expect( setup_called ).toBe( false )

    } )

    it( `runs probes for only the selected command agents`, async () => {

        const checked = []
        const { input, output } = collect_io()

        const results = await cmd_doctor( command( { agent: `all` } ), {
            ...WITHOUT_HOST_CONTEXT,
            input,
            output,
            setup: setup_result( mounts ),
            resolve_image_identity: async () => null,
            run_auth_check: async ( agent, options ) => {
                checked.push( { name: agent.name, options } )
                return { name: agent.name, status: `authenticated`, authenticated: true }
            },
        } )

        expect( checked.map( check => check.name ) ).toEqual( SUPPORTED_AGENTS )
        expect( results.map( result => result.name ) ).toEqual( SUPPORTED_AGENTS )
        expect( checked.every( check => check.options.config.isolate_dependencies === false ) ).toBe( true )
        expect( checked.find( check => check.name === `codex` ).options.creds_mounts ).toEqual( mounts )
        expect( checked.filter( check => check.name !== `codex` )
            .every( check => check.options.creds_mounts.length === 0 ) ).toBe( true )

    } )

    it( `uses a matching success cache without making a model-backed probe`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        const { input, output, rendered } = collect_io()

        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path } )

        const results = await cmd_doctor( command(), {
            ...WITHOUT_HOST_CONTEXT,
            cache_path,
            input,
            output,
            setup: setup_result( mounts ),
            resolve_image_identity: async () => IMAGE_IDENTITY,
            run_auth_check: async () => {
                throw new Error( `cached auth must not run a probe` )
            },
        } )

        expect( results ).toEqual( [ {
            name: `codex`,
            status: `cached`,
            authenticated: true,
        } ] )
        expect( rendered() ).toContain( `codex: cached` )

    } )

    it( `bypasses a matching cache entry when --refresh is set`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        const { input, output } = collect_io()
        let probe_calls = 0

        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path } )

        const results = await cmd_doctor( command( { refresh: true } ), {
            ...WITHOUT_HOST_CONTEXT,
            cache_path,
            input,
            output,
            setup: setup_result( mounts ),
            resolve_image_identity: async () => IMAGE_IDENTITY,
            run_auth_check: async agent => {
                probe_calls += 1
                return { name: agent.name, status: `authenticated`, authenticated: true }
            },
        } )

        expect( probe_calls ).toBe( 1 )
        expect( results[0].status ).toBe( `authenticated` )

    } )

    it( `invalidates an old success before a forced check`, async () => {

        const identity = fingerprint_agent_credentials( get_agent( `codex` ), mounts )
        const { input, output } = collect_io()

        record_host_auth_success( `codex`, {
            credential_fingerprint: identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path } )

        await cmd_doctor( command( { refresh: true } ), {
            ...WITHOUT_HOST_CONTEXT,
            cache_path,
            input,
            output,
            setup: setup_result( mounts ),
            resolve_image_identity: async () => IMAGE_IDENTITY,
            run_auth_check: async agent => ( {
                name: agent.name,
                status: `cancelled`,
                authenticated: false,
            } ),
        } )

        expect( read_host_auth_cache( { cache_path } ).agents.codex ).toBeUndefined()

    } )

    it( `writes cache metadata only for authenticated probe results`, async () => {

        const statuses = [ `authenticated`, `unauthenticated`, `failed`, `skipped`, `cancelled` ]

        for( const status of statuses ) {
            const status_cache_path = join( directory, `${ status }.json` )
            const { input, output } = collect_io()

            await cmd_doctor( command( { refresh: true } ), {
                ...WITHOUT_HOST_CONTEXT,
                cache_path: status_cache_path,
                input,
                output,
                setup: setup_result( mounts ),
                resolve_image_identity: async () => IMAGE_IDENTITY,
                run_auth_check: async agent => ( {
                    name: agent.name,
                    status,
                    authenticated: status === `authenticated`,
                } ),
            } )

            const entry = read_host_auth_cache( { cache_path: status_cache_path } ).agents.codex

            if( status === `authenticated` ) {
                expect( entry?.image_identity ).toBe( IMAGE_IDENTITY )
                expect( entry?.credential_fingerprint ).toBeString()
            } else {
                expect( entry ).toBeUndefined()
            }
        }

    } )

    it( `always tears down staged credentials when diagnostic work throws`, async () => {

        const cleanup_path = join( directory, `credential-transport` )
        const events = []
        const sync = {
            stop: async () => events.push( `stop` ),
            cleanup: () => {
                events.push( `cleanup` )
                rmSync( cleanup_path, { recursive: true, force: true } )
                return true
            },
        }

        mkdirSync( cleanup_path )

        await expect( cmd_doctor( command(), {
            ...WITHOUT_HOST_CONTEXT,
            ...collect_io(),
            setup: setup_result( mounts, sync ),
            resolve_image_identity: async () => {
                throw new Error( `image inspection failed` )
            },
            cache_path,
        } ) ).rejects.toThrow( /image inspection failed/ )

        expect( events ).toEqual( [ `stop`, `cleanup` ] )
        expect( existsSync( cleanup_path ) ).toBe( false )

    } )

    it( `releases the auth lease when recovery registration fails`, async () => {

        const events = []

        await expect( cmd_doctor( command(), {
            ...WITHOUT_HOST_CONTEXT,
            ...collect_io(),
            setup: setup_result( [], {
                stop: async () => events.push( `stop` ),
                cleanup: () => true,
            } ),
            acquire_lease: async () => ( {
                release: () => events.push( `release` ),
            } ),
            register_recovery: () => { throw new Error( `registration failed` ) },
        } ) ).rejects.toThrow( /registration failed/ )

        expect( events ).toEqual( [ `stop`, `release` ] )

    } )

} )
