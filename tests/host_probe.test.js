import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { is_authentication_failure } from '../src/agents/auth.js'
import { get_agent } from '../src/agents/index.js'
import { read_host_credential, resolve_host_bin, run_host_cli_auth_check } from '../src/agents/host_probe.js'

const claude = get_agent( `claude` )
const codex = get_agent( `codex` )

describe( `host CLI auth probe`, () => {

    let directory

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-host-probe-` ) )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    // A stand-in agent CLI: prints its script, exits with its code
    const fake_cli = ( script, code = 0 ) => {
        const path = join( directory, `fake-agent` )
        writeFileSync( path, `#!/bin/sh\n${ script }\nexit ${ code }\n` )
        chmodSync( path, 0o755 )
        return () => path
    }
    const probe = ( agent, resolve_bin, options = {} ) => run_host_cli_auth_check( agent, { resolve_bin, env: { PATH: process.env.PATH }, ...options } )

    it( `classifies the real logged-in and logged-out outputs`, async () => {

        expect( await probe( claude, fake_cli( `echo ok` ) ) ).toMatchObject( { name: `claude`, status: `authenticated`, probe: `host` } )
        expect( await probe( claude, fake_cli( `echo "Not logged in · Please run /login"`, 1 ) ) ).toMatchObject( { status: `unauthenticated` } )
        expect( await probe( claude, fake_cli( `echo "Failed to authenticate: OAuth session expired and could not be refreshed" >&2`, 1 ) ) ).toMatchObject( { status: `unauthenticated` } )
        expect( await probe( codex, fake_cli( `echo "ERROR: unexpected status 401 Unauthorized: Missing bearer" >&2`, 1 ) ) ).toMatchObject( { status: `unauthenticated` } )
        expect( await probe( codex, fake_cli( `echo "stream disconnected" >&2`, 1 ) ) ).toMatchObject( { status: `failed`, reason: `stream disconnected` } )

    } )

    it( `runs in a scratch directory with every customization off`, async () => {

        const seen = []
        await probe( claude, fake_cli( `pwd; echo ok` ), {
            spawn_fn: ( bin, args, options ) => {
                seen.push( { args, cwd: options.cwd, detached: options.detached } )
                return spawn( bin, args, options )
            },
        } )

        expect( seen[0].args ).toEqual( expect.arrayContaining( [ `--safe-mode`, `--strict-mcp-config`, `--no-session-persistence` ] ) )
        expect( seen[0].args.slice( -2 ) ).toEqual( [ `--tools`, `` ] )
        expect( seen[0].cwd.startsWith( tmpdir() ) ).toBe( true )
        expect( seen[0].detached ).toBe( true )

    } )

    it( `yields to a launch and times out without hanging`, async () => {

        const controller = new AbortController()
        const yielded = probe( claude, fake_cli( `sleep 30` ), { signal: controller.signal, kill_grace_ms: 50 } )
        setTimeout( () => controller.abort( { code: `skip` } ), 50 )
        expect( await yielded ).toMatchObject( { status: `skipped` } )

        expect( await probe( claude, fake_cli( `sleep 30` ), { timeout_ms: 50, kill_grace_ms: 50 } ) ).toMatchObject( { status: `failed`, reason: `timed out` } )

    } )

    it( `declines when the CLI is absent, unsupported, or reads a relocated config`, async () => {

        expect( await probe( claude, () => null ) ).toBeNull()
        expect( await probe( get_agent( `antigravity` ), fake_cli( `echo ok` ) ) ).toBeNull()
        expect( await probe( claude, fake_cli( `echo ok` ), { env: { HOME: `/home/a`, CLAUDE_CONFIG_DIR: `/elsewhere` } } ) ).toBeNull()
        expect( claude.auth_check.host_args( `p`, { env: { HOME: `/home/a`, CLAUDE_CONFIG_DIR: `~/.claude` } } ) ).not.toBeNull()
        expect( resolve_host_bin( `sh`, { PATH: `/nonexistent:/bin:/usr/bin` } ) ).toMatch( /\/sh$/ )
        expect( resolve_host_bin( `no-such-agent-cli`, { PATH: `/bin` } ) ).toBeNull()

    } )

    it( `reads credential files, treating only ENOENT as absent`, () => {

        const error = code => () => {
            throw Object.assign( new Error( code ), { code } )
        }

        expect( read_host_credential( codex, { platform: `linux`, read_file: () => `{}` } ) ).toEqual( { state: `present`, text: `{}` } )
        expect( read_host_credential( codex, { platform: `linux`, read_file: error( `ENOENT` ) } ) ).toEqual( { state: `absent` } )
        expect( read_host_credential( codex, { platform: `linux`, read_file: error( `EACCES` ) } ) ).toEqual( { state: `unknown` } )
        // Keychain logins are never judged offline
        expect( read_host_credential( claude, { platform: `darwin`, read_file: error( `ENOENT` ) } ) ).toEqual( { state: `unknown` } )

    } )

} )

describe( `login evidence`, () => {

    const jwt = exp => `h.${ Buffer.from( JSON.stringify( { exp } ) ).toString( `base64url` ) }.s`
    const now = Date.parse( `2026-10-10T12:00:00Z` )

    it( `ignores connector noise but keeps adapter phrasings`, () => {

        expect( is_authentication_failure( `MCP client startup failed: 401 Unauthorized\nok` ) ).toBe( false )
        expect( is_authentication_failure( `OAuth token has expired`, claude ) ).toBe( true )
        expect( is_authentication_failure( `Your refresh token was already used`, codex ) ).toBe( true )

    } )

    it( `knows when a probe cannot rotate the refresh token`, () => {

        const claude_credential = expires => JSON.stringify( { claudeAiOauth: { expiresAt: expires, refreshTokenExpiresAt: now + 1 } } )
        expect( claude.auth_check.refresh_free( claude_credential( now + 3_600_000 ), now ) ).toBe( true )
        expect( claude.auth_check.refresh_free( claude_credential( now + 60_000 ), now ) ).toBe( false )
        expect( claude.auth_check.refresh_free( `not json`, now ) ).toBe( false )
        expect( claude.auth_check.refresh_expires_at( claude_credential( 0 ) ) ).toBe( now + 1 )

        const codex_credential = ( exp, last_refresh ) => JSON.stringify( { tokens: { access_token: jwt( exp ) }, last_refresh } )
        expect( codex.auth_check.refresh_free( codex_credential( now / 1_000 + 3_600, `2026-10-09T00:00:00Z` ), now ) ).toBe( true )
        expect( codex.auth_check.refresh_free( codex_credential( now / 1_000 + 60, `2026-10-09T00:00:00Z` ), now ) ).toBe( false )
        expect( codex.auth_check.refresh_free( codex_credential( now / 1_000 + 3_600, `2026-09-01T00:00:00Z` ), now ) ).toBe( false )
        expect( codex.auth_check.refresh_free( JSON.stringify( { OPENAI_API_KEY: `k` } ), now ) ).toBe( true )

    } )

} )
