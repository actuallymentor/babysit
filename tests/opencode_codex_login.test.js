import { describe, it, expect } from 'bun:test'

import { LENT_MARKER, compose_opencode_auth, lent_openai_entry, strip_lent_logins } from '../src/agents/opencode_codex_login.js'

// A JWT whose payload says exp = 2_000_000_000 (signature irrelevant)
const jwt = `x.${ Buffer.from( JSON.stringify( { exp: 2_000_000_000 } ) ).toString( `base64url` ) }.y`
const codex = JSON.stringify( { auth_mode: `chatgpt`, tokens: { access_token: jwt, refresh_token: `never-lent`, id_token: `id`, account_id: `acct-1` } } )

describe( `OpenCode borrows the Codex ChatGPT login`, () => {

    it( `lends the access token with its real expiry, never the refresh token`, () => {
        const entry = lent_openai_entry( codex )
        expect( entry ).toEqual( { type: `oauth`, refresh: ``, access: jwt, expires: 2_000_000_000_000, accountId: `acct-1`, [ LENT_MARKER ]: `codex` } )
        expect( JSON.stringify( entry ) ).not.toContain( `never-lent` )
    } )

    it( `lends nothing without a ChatGPT login`, () => {
        expect( lent_openai_entry( null ) ).toBe( null )
        expect( lent_openai_entry( JSON.stringify( { OPENAI_API_KEY: `sk-x`, tokens: null } ) ) ).toBe( null )
        expect( lent_openai_entry( `{partial` ) ).toBe( null )
    } )

    it( `adds the lent entry beside the host's own providers, and a host file can be absent`, () => {
        const composed = JSON.parse( compose_opencode_auth( JSON.stringify( { openrouter: { type: `api`, key: `k` } } ), codex ) )
        expect( Object.keys( composed ) ).toEqual( [ `openrouter`, `openai` ] )
        expect( composed.openai.access ).toBe( jwt )
        expect( JSON.parse( compose_opencode_auth( null, codex ) ).openai.accountId ).toBe( `acct-1` )
    } )

    it( `an OpenCode login of its own wins`, () => {
        const own = JSON.stringify( { openai: { type: `oauth`, refresh: `own`, access: `own`, expires: 1 } } )
        expect( compose_opencode_auth( own, codex ) ).toBe( own )
    } )

    it( `passes the host text through when nothing is lent or it is mid-write`, () => {
        expect( compose_opencode_auth( `{"openrouter":{"type":"api","key":"k"}}`, null ) ).toBe( `{"openrouter":{"type":"api","key":"k"}}` )
        expect( compose_opencode_auth( `{partial`, codex ) ).toBe( `{partial` )
        expect( compose_opencode_auth( null, null ) ).toBe( null )
    } )

    it( `strips only the lent entry before a write back`, () => {
        const container = compose_opencode_auth( JSON.stringify( { openrouter: { type: `api`, key: `k` } } ), codex )
        expect( JSON.parse( strip_lent_logins( container ) ) ).toEqual( { openrouter: { type: `api`, key: `k` } } )
        const own = JSON.stringify( { openai: { type: `oauth`, refresh: `own` } } )
        expect( strip_lent_logins( own ) ).toBe( own )
    } )

} )

describe( `composed credential sync`, async () => {

    const { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } = await import( 'fs' )
    const { tmpdir } = await import( 'os' )
    const { join } = await import( 'path' )
    const { setup_agent_credentials } = await import( '../src/credentials/setup.js' )

    it( `stages the lent login without a host file and never writes it back`, async () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-compose-` ) )
        const host = join( directory, `auth.json` )
        let codex_login = codex
        const agent = {
            name: `opencode`,
            credentials: {
                sources: { linux: [ { file: host } ] },
                compose: { read: text => compose_opencode_auth( text, codex_login ), strip: strip_lent_logins },
            },
            container_paths: { creds: `/home/node/.local/share/opencode/auth.json` },
        }
        const result = setup_agent_credentials( agent, { platform: `linux` } )
        try {
            const [ mount ] = result.mounts
            expect( JSON.parse( readFileSync( mount.source, `utf8` ) ).openai.access ).toBe( jwt )

            // OpenCode in the container adds a login of its own: only that reaches the host
            const inside = JSON.parse( readFileSync( mount.source, `utf8` ) )
            writeFileSync( mount.source, JSON.stringify( { ...inside, openrouter: { type: `api`, key: `k` } } ) )
            result.sync.set_transport( { pull: async () => {}, push: async () => {} } )
            await result.sync.flush()
            expect( JSON.parse( readFileSync( host, `utf8` ) ) ).toEqual( { openrouter: { type: `api`, key: `k` } } )

            // Codex refreshed on the host: the next tick lends the new token
            const fresh = `x.${ Buffer.from( JSON.stringify( { exp: 2_100_000_000 } ) ).toString( `base64url` ) }.z`
            codex_login = JSON.stringify( { tokens: { access_token: fresh, account_id: `acct-1` } } )
            await result.sync.flush()
            expect( JSON.parse( readFileSync( mount.source, `utf8` ) ).openai.access ).toBe( fresh )
            expect( existsSync( host ) && readFileSync( host, `utf8` ) ).not.toContain( `x.` )
        } finally {
            await result.sync.stop()
            rmSync( directory, { recursive: true, force: true } )
            if( result.cleanup_path ) rmSync( result.cleanup_path, { recursive: true, force: true } )
        }
    } )

} )
