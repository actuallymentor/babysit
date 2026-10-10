import { describe, it, expect } from 'bun:test'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'

import { read_pasted_token, save_claude_token, setup_claude_token, token_probe_env } from '../src/cli/claude_token.js'

const TOKEN = `sk-ant-oat01-Abc_def-123`

const terminal = () => {
    const chunks = []
    return {
        input: Object.assign( new PassThrough(), { isTTY: true } ),
        output: { isTTY: true, write: chunk => chunks.push( chunk ) },
        rendered: () => chunks.join( `` ),
    }
}

// Everything a real run would touch is a seam; each test overrides what it probes
const run = ( flags = {}, overrides = {} ) => {
    const { input, output, rendered } = terminal()
    const calls = { setup: 0, saved: null }
    const outcome = setup_claude_token( { flags }, {
        input, output,
        env: {},
        resolve_bin: () => `/usr/bin/claude`,
        confirm: async () => true,
        setup: async () => ++calls.setup && true,
        paste: async () => TOKEN,
        verify: async () => ( { authenticated: true, status: `authenticated` } ),
        save: token => ( calls.saved = token, `/home/me/.babysitrc` ),
        ...overrides,
    } )
    return outcome.then( result => ( { result, calls, rendered: rendered() } ) )
}

describe( `claude setup-token in auth init`, () => {

    it( `mints, verifies, and saves the token when the user agrees`, async () => {
        const env = {}
        const { result, calls, rendered } = await run( {}, { env } )
        expect( result ).toBe( `saved` )
        expect( calls ).toEqual( { setup: 1, saved: TOKEN } )
        expect( env.CLAUDE_CODE_OAUTH_TOKEN ).toBe( TOKEN )
        expect( rendered ).toContain( `restart running Claude sessions` )
    } )

    it( `keeps an existing token unless --claude-token asks for a new one`, async () => {
        const env = { CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-old` }
        expect( ( await run( {}, { env } ) ).result ).toBe( `present` )
        expect( ( await run( { claude_token: true }, { env } ) ).calls.saved ).toBe( TOKEN )
    } )

    it( `skips on --no-claude-token, without claude, when declined, or outside a terminal`, async () => {
        expect( ( await run( { claude_token: false } ) ).result ).toBe( `skipped` )
        expect( ( await run( {}, { resolve_bin: () => null } ) ).result ).toBe( `skipped` )

        const declined = await run( {}, { confirm: async () => false } )
        expect( declined ).toMatchObject( { result: `skipped`, calls: { setup: 0 } } )

        const { output, rendered } = terminal()
        output.isTTY = false
        expect( await setup_claude_token( { flags: {} }, { output, env: {}, resolve_bin: () => `/usr/bin/claude` } ) ).toBe( `skipped` )
        expect( rendered() ).toContain( `babysit auth init --claude-token` )
    } )

    it( `saves nothing for a failed mint, a malformed paste, or a rejected token`, async () => {
        expect( ( await run( {}, { setup: async () => false } ) ).calls.saved ).toBe( null )
        expect( ( await run( {}, { paste: async () => `hello` } ) ).calls.saved ).toBe( null )

        const rejected = await run( {}, { verify: async () => ( { authenticated: false, status: `unauthenticated`, reason: `401` } ) } )
        expect( rejected ).toMatchObject( { result: `failed`, calls: { saved: null } } )
        expect( rejected.rendered ).toContain( `Could not prove the token (401)` )
        expect( ( await run( {}, { verify: async () => null } ) ).calls.saved ).toBe( null )
    } )

    it( `proves the pasted token alone, never a route that outranks it`, () => {
        const env = token_probe_env( { PATH: `/bin`, ANTHROPIC_API_KEY: `k`, CLAUDE_CODE_USE_BEDROCK: `1`, CLAUDE_CONFIG_DIR: `/x`, CLAUDE_CODE_OAUTH_TOKEN: `old` }, TOKEN )
        expect( env ).toEqual( { PATH: `/bin`, CLAUDE_CODE_OAUTH_TOKEN: TOKEN } )
    } )

    it( `joins a token the terminal wrapped across lines`, async () => {
        const { input, output } = terminal()
        const pasted = read_pasted_token( { input, output } )
        input.write( `sk-ant-oat01-Abc_\n  def-123\n\n` )
        expect( await pasted ).toBe( TOKEN )
    } )

    it( `replaces only its own rc block, leaves user lines, and stays 0600`, () => {
        const files = { rc: `if true; then\n  export CLAUDE_CODE_OAUTH_TOKEN=mine\nfi\nexport CLAUDE_CODE_OAUTH_TOKEN=x PUSHOVER_USER=u\n# Claude setup-token from babysit auth init, 2025-01-01; expires ~2026-01-01\nexport CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-old\nFOO=1\n` }
        const modes = []
        save_claude_token( TOKEN, {
            path: `rc`,
            now: new Date( `2026-10-10T12:00:00Z` ),
            read: path => files[ path ],
            write: ( path, content, options ) => ( files[ path ] = content, modes.push( options.mode ) ),
            chmod: ( path, mode ) => modes.push( mode ),
        } )
        expect( files.rc ).toBe( `if true; then\n  export CLAUDE_CODE_OAUTH_TOKEN=mine\nfi\nexport CLAUDE_CODE_OAUTH_TOKEN=x PUSHOVER_USER=u\nFOO=1\n\n# Claude setup-token from babysit auth init, 2026-10-10; expires ~2027-10-10\nexport CLAUDE_CODE_OAUTH_TOKEN=${ TOKEN }\n` )
        expect( modes ).toEqual( [ 0o600, 0o600 ] )

        const sourced = spawnSync( `bash`, [ `-c`, `${ files.rc }printf %s "$CLAUDE_CODE_OAUTH_TOKEN $PUSHOVER_USER"` ], { encoding: `utf8`, env: { PATH: process.env.PATH } } )
        expect( sourced.stdout ).toBe( `${ TOKEN } u` )
    } )

} )
