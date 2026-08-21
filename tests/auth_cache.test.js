import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
    HOST_AUTH_CACHE_TTL_MS,
    clear_host_auth_cache,
    credential_mounts_for_agent,
    find_host_auth_cache_hit,
    fingerprint_agent_credentials,
    read_host_auth_cache,
    record_host_auth_success,
    refresh_host_auth_cache,
    resolve_auth_image_identity,
} from '../src/agents/auth_cache.js'
import { get_agent } from '../src/agents/index.js'
import { refresh_session_auth_cache } from '../src/cli/monitor.js'

const NOW = Date.parse( `2026-08-20T12:00:00.000Z` )
const CREDENTIAL_FINGERPRINT = `credential-fingerprint`
const IMAGE_IDENTITY = `sha256:image`

describe( `host authentication cache`, () => {

    let directory
    let cache_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-auth-cache-` ) )
        cache_path = join( directory, `cache.json` )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `hits only inside the TTL with matching credentials and image`, () => {

        const entry = record_host_auth_success( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } )

        expect( find_host_auth_cache_hit( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, {
            cache_path,
            now: NOW + HOST_AUTH_CACHE_TTL_MS - 1,
        } ) ).toEqual( entry )

        expect( find_host_auth_cache_hit( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, {
            cache_path,
            now: NOW + HOST_AUTH_CACHE_TTL_MS,
        } ) ).toBeNull()

        expect( find_host_auth_cache_hit( `codex`, {
            credential_fingerprint: `changed-credential`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } ) ).toBeNull()

        expect( find_host_auth_cache_hit( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: `sha256:changed-image`,
        }, { cache_path, now: NOW } ) ).toBeNull()

    } )

    it( `treats corrupt cache content as an empty miss`, () => {

        writeFileSync( cache_path, `{ definitely not json` )

        expect( read_host_auth_cache( { cache_path } ) ).toEqual( {
            version: 1,
            agents: {},
        } )
        expect( find_host_auth_cache_hit( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } ) ).toBeNull()

    } )

    it( `fingerprints only relevant credentials without retaining secrets`, () => {

        const agent = {
            credentials: {
                linux: {
                    env_key: `PRIMARY_TOKEN`,
                    fallback_env: `FALLBACK_TOKEN`,
                },
            },
            container_paths: { creds: `/agent/credential.json` },
        }
        const mounts = [
            { type: `secret_env`, key: `FALLBACK_TOKEN`, value: `fallback-secret` },
            { type: `env`, key: `UNRELATED_TOKEN`, value: `ignore-me` },
            { type: `env`, key: `PRIMARY_TOKEN`, value: `primary-secret` },
            { type: `synced_file`, source: `/host/credential.json`, target: `/agent/credential.json` },
        ]
        const identity = fingerprint_agent_credentials( agent, mounts, {
            read_file: path => {
                expect( path ).toBe( `/host/credential.json` )
                return `file-secret`
            },
        } )

        expect( identity.parts.map( part => `${ part.kind }:${ part.target || part.key }` ) ).toEqual( [
            `env:FALLBACK_TOKEN`,
            `env:PRIMARY_TOKEN`,
            `file:/agent/credential.json`,
        ] )
        expect( JSON.stringify( identity ) ).not.toContain( `secret` )
        expect( credential_mounts_for_agent( agent, mounts ) ).toEqual( [
            mounts[0],
            mounts[2],
            mounts[3],
        ] )
        expect( mounts ).toHaveLength( 4 )

        const reordered = fingerprint_agent_credentials( agent, [ ...mounts ].reverse(), {
            read_file: () => `file-secret`,
        } )
        const changed = fingerprint_agent_credentials( agent, mounts, {
            read_file: () => `rotated-file-secret`,
        } )

        expect( reordered.fingerprint ).toBe( identity.fingerprint )
        expect( changed.fingerprint ).not.toBe( identity.fingerprint )

    } )

    it( `binds cache identity to shared authentication context`, () => {

        const agent = get_agent( `opencode` )
        const options = content => ( {
            context_files: { babysitrc: `/host/.babysitrc` },
            read_file: path => {
                expect( path ).toBe( `/host/.babysitrc` )
                return content
            },
        } )

        const first = fingerprint_agent_credentials( agent, [], options( `API_KEY=first` ) )
        const changed = fingerprint_agent_credentials( agent, [], options( `API_KEY=changed` ) )

        expect( first.parts ).toHaveLength( 1 )
        expect( first.parts[0].kind ).toBe( `context` )
        expect( JSON.stringify( first ) ).not.toContain( `API_KEY` )
        expect( changed.fingerprint ).not.toBe( first.fingerprint )
        expect( fingerprint_agent_credentials( agent, [], {
            context_files: { babysitrc: `/unreadable` },
            read_file: () => { throw new Error( `unreadable` ) },
        } ) ).toBeNull()

    } )

    it( `resolves the immutable Docker image identity and misses safely`, async () => {

        const calls = []
        const identity = await resolve_auth_image_identity( {
            image: `babysit:test`,
            command_prefix: [ `sudo`, `docker` ],
            run_command: async ( command, args, options, timeout_ms ) => {
                calls.push( { command, args, options, timeout_ms } )
                return `sha256:resolved-image`
            },
        } )

        expect( identity ).toBe( `sha256:resolved-image` )
        expect( calls ).toEqual( [ {
            command: `sudo`,
            args: [ `docker`, `image`, `inspect`, `babysit:test`, `--format`, `{{.Id}}` ],
            options: {},
            timeout_ms: 5_000,
        } ] )

        await expect( resolve_auth_image_identity( {
            run_command: async () => {
                throw new Error( `Docker unavailable` )
            },
        } ) ).resolves.toBeNull()

    } )

    it( `writes only complete successful identities`, () => {

        expect( record_host_auth_success( `codex`, {
            credential_fingerprint: null,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } ) ).toBeNull()
        expect( record_host_auth_success( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: null,
        }, { cache_path, now: NOW } ) ).toBeNull()
        expect( existsSync( cache_path ) ).toBe( false )

        record_host_auth_success( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } )

        const serialized = readFileSync( cache_path, `utf8` )
        expect( serialized ).toContain( CREDENTIAL_FINGERPRINT )
        expect( serialized ).toContain( IMAGE_IDENTITY )
        expect( existsSync( `${ cache_path }.lock` ) ).toBe( false )

    } )

    it( `keeps cache I/O failures from breaking successful work`, () => {

        const blocked_parent = join( directory, `not-a-directory` )
        const blocked_cache = join( blocked_parent, `cache.json` )
        writeFileSync( blocked_parent, `blocked` )

        expect( record_host_auth_success( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path: blocked_cache, now: NOW } ) ).toBeNull()

        expect( refresh_host_auth_cache( `codex`, {
            expected_credential_fingerprint: CREDENTIAL_FINGERPRINT,
            next_credential_fingerprint: `rotated`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path: blocked_cache, now: NOW } ) ).toBe( false )

        expect( clear_host_auth_cache( `codex`, { cache_path: blocked_cache } ) ).toBe( false )

    } )

    it( `refreshes rotated credentials only through a matching compare-and-swap`, () => {

        record_host_auth_success( `codex`, {
            credential_fingerprint: CREDENTIAL_FINGERPRINT,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } )

        expect( refresh_host_auth_cache( `codex`, {
            expected_credential_fingerprint: `stale-observer`,
            next_credential_fingerprint: `rotated-credential`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW + 1_000 } ) ).toBe( false )

        expect( refresh_host_auth_cache( `codex`, {
            expected_credential_fingerprint: CREDENTIAL_FINGERPRINT,
            next_credential_fingerprint: `rotated-credential`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW + 1_000 } ) ).toBe( true )

        const refreshed = read_host_auth_cache( { cache_path } ).agents.codex
        expect( refreshed.credential_fingerprint ).toBe( `rotated-credential` )
        expect( refreshed.authenticated_at ).toBe( new Date( NOW ).toISOString() )

        expect( refresh_host_auth_cache( `codex`, {
            expected_credential_fingerprint: CREDENTIAL_FINGERPRINT,
            next_credential_fingerprint: `overwritten-credential`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW + 2_000 } ) ).toBe( false )
        expect( read_host_auth_cache( { cache_path } ).agents.codex.credential_fingerprint )
            .toBe( `rotated-credential` )

    } )

    it( `does not let a stale failure clear a newer success`, () => {

        record_host_auth_success( `codex`, {
            credential_fingerprint: `newer-credential`,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } )

        expect( clear_host_auth_cache( `codex`, {
            cache_path,
            expected_credential_fingerprint: `stale-credential`,
            image_identity: IMAGE_IDENTITY,
        } ) ).toBe( true )
        expect( read_host_auth_cache( { cache_path } ).agents.codex.credential_fingerprint )
            .toBe( `newer-credential` )

    } )

    it( `preserves every warm result when cache invalidation cannot lock`, () => {

        for( const name of [ `claude`, `codex` ] ) {
            record_host_auth_success( name, {
                credential_fingerprint: `${ name }-credential`,
                image_identity: IMAGE_IDENTITY,
            }, { cache_path, now: NOW } )
        }

        expect( clear_host_auth_cache( `codex`, {
            cache_path,
            lock_cache: () => { throw new Error( `busy` ) },
        } ) ).toBe( false )
        expect( Object.keys( read_host_auth_cache( { cache_path } ).agents ) )
            .toEqual( [ `claude`, `codex` ] )

    } )

    it( `keeps trust across session token rotation but clears it on host replacement`, () => {

        const agent = get_agent( `codex` )
        const credential_file = join( directory, `credential.json` )
        const mounts = [ {
            type: `synced_file`,
            source: credential_file,
            target: agent.container_paths.creds,
        } ]

        writeFileSync( credential_file, `{ "token": "before" }` )
        const initial_identity = fingerprint_agent_credentials( agent, mounts )
        record_host_auth_success( agent.name, {
            credential_fingerprint: initial_identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW } )

        const session = {
            auth_cache_context: {
                credential_fingerprint: initial_identity.fingerprint,
                credential_parts: initial_identity.parts,
                image_identity: IMAGE_IDENTITY,
            },
        }
        const dependencies = {
            clear_cache: name => clear_host_auth_cache( name, { cache_path } ),
            refresh_cache: ( name, identity ) => refresh_host_auth_cache( name, identity, {
                cache_path,
                now: NOW + 1_000,
            } ),
        }

        writeFileSync( credential_file, `{ "token": "rotated" }` )
        expect( refresh_session_auth_cache(
            session,
            agent,
            { source_changed: () => false },
            { codex: credential_file },
            dependencies
        ) ).toBe( true )

        const rotated_identity = fingerprint_agent_credentials( agent, mounts )
        expect( find_host_auth_cache_hit( agent.name, {
            credential_fingerprint: rotated_identity.fingerprint,
            image_identity: IMAGE_IDENTITY,
        }, { cache_path, now: NOW + 2_000 } ) ).not.toBeNull()

        expect( refresh_session_auth_cache(
            {
                auth_cache_context: {
                    ...session.auth_cache_context,
                    credential_fingerprint: rotated_identity.fingerprint,
                },
            },
            agent,
            { source_changed: () => true },
            { codex: credential_file },
            dependencies
        ) ).toBe( false )
        expect( read_host_auth_cache( { cache_path } ).agents.codex ).toBeUndefined()

    } )

    it( `refreshes and invalidates session trust independently per agent`, () => {

        const cleared = []
        const refreshed = []
        const context = name => ( {
            credential_fingerprint: `${ name }-before`,
            credential_parts: [ { kind: `env`, key: `${ name }_KEY`, hash: `${ name }-hash` } ],
            image_identity: IMAGE_IDENTITY,
        } )

        const result = refresh_session_auth_cache( {
            auth_cache_contexts: {
                codex: context( `codex` ),
                gemini: context( `gemini` ),
            },
        }, get_agent( `codex` ), {
            source_changed: name => name === `gemini`,
        }, {}, {
            clear_cache: name => cleared.push( name ),
            refresh_cache: name => {
                refreshed.push( name )
                return true
            },
        } )

        expect( result ).toBe( false )
        expect( cleared ).toEqual( [ `gemini` ] )
        expect( refreshed ).toEqual( [ `codex` ] )

    } )

} )
