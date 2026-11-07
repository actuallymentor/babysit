import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { opencode } from '../src/agents/opencode.js'
import { launch_auth_cache_contexts, local_auth_state } from '../src/agents/auth_gate.js'
import { fingerprint_agent_credentials, record_host_auth_success } from '../src/agents/auth_cache.js'

const NOW = Date.parse( `2026-11-07T12:00:00Z` )

// A JWT whose payload only carries exp
const jwt = exp_ms => `h.${ Buffer.from( JSON.stringify( { exp: exp_ms / 1_000 } ) ).toString( `base64url` ) }.s`

const with_file = ( content, task ) => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-auth-gate-` ) )
    const source = join( directory, `auth.json` )
    try {
        if( content !== null ) writeFileSync( source, content )
        return task( source )
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }
}

const file_mount = ( agent, source ) => ( { type: `synced_file`, source, target: agent.container_paths.creds } )

describe( `launch auth gate`, () => {

    it( `codex: a fresh access token is usable, an expired one with a refresh token is refreshable`, () => {
        const state = tokens => with_file( JSON.stringify( { tokens } ), source => local_auth_state( codex, [ file_mount( codex, source ) ], { now: NOW } ) )

        expect( state( { access_token: jwt( NOW + 3_600_000 ), refresh_token: `r` } ) ).toBe( `usable` )
        expect( state( { access_token: jwt( NOW - 3_600_000 ), refresh_token: `r` } ) ).toBe( `refreshable` )
        expect( state( { access_token: jwt( NOW - 3_600_000 ) } ) ).toBe( `missing` )
        expect( with_file( `{`, source => local_auth_state( codex, [ file_mount( codex, source ) ], { now: NOW } ) ) ).toBe( `unknown` )
    } )

    it( `codex: nothing staged is missing, an API key is usable`, () => {
        expect( local_auth_state( codex, [], { now: NOW } ) ).toBe( `missing` )
        expect( local_auth_state( codex, [ { type: `env`, key: `CODEX_API_KEY`, value: `k` } ], { now: NOW } ) ).toBe( `usable` )
    } )

    it( `opencode: credential-free models make an empty store unknown, never missing`, () => {
        expect( local_auth_state( opencode, [] ) ).toBe( `unknown` )
        expect( with_file( `{"openrouter":{"type":"api","key":"k"}}`, source => local_auth_state( opencode, [ file_mount( opencode, source ) ] ) ) ).toBe( `usable` )
    } )

    it( `claude: a route or a setup-token logs in; an absent expiry is unknown`, () => {
        const token = expires_at => [ { type: `account_env`, key: `CLAUDE_CODE_OAUTH_TOKEN`, value: `sk-ant-oat01-x`, account: `default`, ...expires_at && { expires_at } } ]

        expect( local_auth_state( claude, [], { route: `ANTHROPIC_API_KEY` } ) ).toBe( `usable` )
        expect( local_auth_state( claude, [] ) ).toBe( `missing` )
        expect( local_auth_state( claude, token(), { now: NOW } ) ).toBe( `unknown` )
        expect( local_auth_state( claude, token( `2027-11-07` ), { now: NOW } ) ).toBe( `usable` )
        expect( local_auth_state( claude, token( `2026-01-01` ), { now: NOW } ) ).toBe( `missing` )
    } )

    it( `adapters without a gate read as unknown`, () => {
        expect( local_auth_state( { name: `x`, container_paths: {} }, [] ) ).toBe( `unknown` )
    } )

} )

describe( `launch auth cache contexts`, () => {

    it( `inherits fresh verified entries without probing, and skips misses`, async () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-auth-gate-cache-` ) )
        const source = join( directory, `auth.json` )
        const cache_path = join( directory, `cache.json` )

        try {
            writeFileSync( source, `{"tokens":{"refresh_token":"r"}}` )
            const mounts = [ file_mount( codex, source ) ]
            const seams = {
                workspace: directory,
                agents: [ codex, opencode ],
                resolve_image_identity: async () => `sha256:image`,
                resolve_context_files: () => ( {} ),
                resolve_context_values: () => ( {} ),
                cache_options: { cache_path },
            }

            expect( await launch_auth_cache_contexts( codex, mounts, seams ) ).toEqual( {} )

            const { fingerprint, parts } = fingerprint_agent_credentials( codex, mounts )
            record_host_auth_success( `codex`, { credential_fingerprint: fingerprint, image_identity: `sha256:image` }, { cache_path } )

            expect( await launch_auth_cache_contexts( codex, mounts, seams ) ).toEqual( {
                codex: { credential_fingerprint: fingerprint, credential_parts: parts, image_identity: `sha256:image` },
            } )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }

    } )

} )
