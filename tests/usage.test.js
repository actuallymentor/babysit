import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { discover_credentials } from '../src/docker/assets/usage/credentials.mjs'
import { collect_usage, run_usage, format_usage } from '../src/docker/assets/usage/command.mjs'
import { claude_usage, codex_usage, openrouter_usage, provider_request } from '../src/docker/assets/usage/providers.mjs'
import { read_codex_limits } from '../src/docker/assets/usage/codex.mjs'

const no_codex = async () => null
const response = data => new Response( JSON.stringify( data ), { status: 200 } )

describe( `account usage`, () => {

    it( `preserves Claude scoped limits that do not appear in legacy fields`, () => {
        const limits = claude_usage( { seven_day: null, limits: [
            { kind: `weekly_scoped`, percent: 13, resets_at: `2026-09-28T16:00:00Z`, scope: { model: { display_name: `Fable` } } },
        ] } )
        expect( limits[0] ).toEqual( { name: `weekly_scoped / Fable`, used_percent: 13, resets_at: `2026-09-28T16:00:00Z` } )
        expect( claude_usage( { five_hour: { utilization: 0, resets_at: null }, seven_day: null } )[0].used_percent ).toBe( 0 )
    } )

    it( `does not assume Codex primary is five hours or credits are dollars`, () => {
        const limits = codex_usage( { rateLimits: {
            primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790177394 },
            secondary: null, credits: { balance: `12.34`, unlimited: false },
        } } )
        expect( limits[0].name ).toBe( `codex / 10080 min` )
        expect( limits[1] ).toEqual( { name: `credit balance`, unit: `credits`, remaining: `12.34`, unlimited: false } )
    } )

    it( `rejects missing monetary scales and invalid quota duration instead of emitting NaN`, () => {
        expect( () => claude_usage( { spend: { enabled: true, used: { amount_minor: 12, currency: `USD` } } } ) ).toThrow( `invalid money exponent` )
        expect( () => codex_usage( { rate_limit: { primary_window: { used_percent: 20 } } } ) ).toThrow( `invalid quota window duration` )
        expect( () => codex_usage( { rateLimits: { primary: { resetsAt: 1e100 } } } ) ).toThrow( `invalid reset timestamp` )
    } )

    it( `sanitizes managed Codex connection and request failures`, async () => {
        for( const fail_connect of [ false, true ] ) {
            let closed = false
            await expect( read_codex_limits( {
                env: { BABYSIT_EFFORT_AGENT: `codex`, BABYSIT_EFFORT_ENDPOINT: `ws://127.0.0.1:1234` },
                connect: async () => {
                    if( fail_connect ) throw new Error( `Bearer secret-account-token` )
                    return {
                        request: async () => { throw new Error( `Bearer secret-account-token` ) },
                        close: () => { closed = true },
                    }
                },
            } ) ).rejects.toThrow( `Codex could not retrieve account limits; check codex login status` )
            expect( closed ).toBe( !fail_connect )
        }
    } )

    it( `directs expired OpenCode OAuth back to OpenCode without refreshing another account`, async () => {
        let native_calls = 0
        const report = await collect_usage( {
            allow_native_refresh: true,
            credentials: { env: {}, opencode: { openai: { type: `oauth`, access: `expired` } } },
            codex_read: async () => { native_calls++; return null },
            fetch_fn: async () => new Response( `secret upstream body`, { status: 401 } ),
        } )
        const provider = report.agents.find( agent => agent.agent === `opencode` )
        expect( provider.status ).toBe( `error` )
        expect( provider.message ).toContain( `opencode auth login` )
        expect( native_calls ).toBe( 1 ) // Only the independent native Codex account discovery.
        expect( JSON.stringify( report ) ).not.toContain( `secret upstream body` )
    } )

    it( `uses the OpenRouter budget period and accounts for BYOK when enabled`, () => {
        const limits = openrouter_usage( { data: {
            limit: 20, limit_reset: `daily`, limit_remaining: 17,
            usage: 300, usage_daily: 2, byok_usage_daily: 1, include_byok_in_limit: true,
        } } )
        expect( limits[0].used ).toBe( 3 )
        expect( limits[0].limit ).toBe( 20 )
        expect( limits[1].used ).toBe( 300 )
    } )

    it( `keeps successful providers visible when another rejects auth without echoing secrets`, async () => {
        const report = await collect_usage( { codex_read: no_codex,
            credentials: {
                env: {}, claude: { claudeAiOauth: { accessToken: `private-token` } },
                opencode: { openrouter: { type: `api`, key: `private-key` } },
            },
            fetch_fn: async url => url.includes( `anthropic` )
                ? new Response( `private-token private-key`, { status: 401 } )
                : response( { data: { limit: 20, usage_daily: 2, limit_reset: `daily`, limit_remaining: 18 } } ),
        } )
        expect( report.agents.find( agent => agent.agent === `claude` ).status ).toBe( `error` )
        expect( report.agents.find( agent => agent.agent === `opencode` ).status ).toBe( `ok` )
        expect( JSON.stringify( report ) ).not.toContain( `private-` )
        expect( format_usage( report ) ).toContain( `2 / 20 USD used` )
    } )

    it( `exposes authenticated unsupported providers instead of fabricating usage`, async () => {
        const report = await collect_usage( { codex_read: no_codex, credentials: { env: {}, opencode: { custom: { type: `api`, key: `secret` } } } } )
        expect( report.agents.find( agent => agent.provider === `custom` ).status ).toBe( `unavailable` )
    } )

    it( `reuses OAuth provider adapters for OpenCode accounts`, async () => {
        const calls = []
        const report = await collect_usage( { codex_read: no_codex,
            credentials: { env: {}, opencode: {
                anthropic: { type: `oauth`, access: `claude-token` },
                openai: { type: `oauth`, access: `codex-token`, accountId: `account` },
            } },
            fetch_fn: async ( url, options ) => {
                calls.push( { url, headers: options.headers } )
                return response( url.includes( `anthropic` )
                    ? { five_hour: { utilization: 5 } }
                    : { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000, reset_at: 1790177394 } } } )
            },
        } )
        expect( report.agents.filter( agent => agent.agent === `opencode` ).every( agent => agent.status === `ok` ) ).toBe( true )
        expect( calls.find( call => call.url.includes( `chatgpt` ) ).headers[ `ChatGPT-Account-Id` ] ).toBe( `account` )
    } )

    it( `refreshes expired Codex auth only when the host lease owner opts in`, async () => {
        for( const allow_native_refresh of [ false, true ] ) {
            let native_calls = 0
            const report = await collect_usage( {
                allow_native_refresh,
                credentials: { env: allow_native_refresh ? {} : { BABYSIT_DOCKER: `1` }, codex: { tokens: { access_token: `expired` } } },
                fetch_fn: async () => new Response( `secret upstream body`, { status: 401 } ),
                codex_read: async () => {
                    native_calls++
                    return { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } }
                },
            } )
            const codex = report.agents.find( agent => agent.agent === `codex` )
            expect( native_calls ).toBe( allow_native_refresh ? 1 : 0 )
            expect( codex.status ).toBe( allow_native_refresh ? `ok` : `error` )
            expect( JSON.stringify( report ) ).not.toContain( `secret upstream body` )
        }
    } )

    it( `does not refresh credentials for provider throttling or other HTTP failures`, async () => {
        let native_calls = 0
        const report = await collect_usage( {
            allow_native_refresh: true,
            credentials: { env: {}, codex: { tokens: { access_token: `token` } } },
            fetch_fn: async () => new Response( ``, { status: 429 } ),
            codex_read: async () => { native_calls++; return null },
        } )
        expect( native_calls ).toBe( 0 )
        expect( report.agents.find( agent => agent.agent === `codex` ).status ).toBe( `error` )
    } )

    it( `honors custom credential homes and platform keychains without invoking login`, async () => {
        const paths = []
        const commands = []
        const auth = await discover_credentials( {
            home: `/host/alice`, platform: `darwin`,
            env: { CODEX_HOME: `~/custom-codex`, CLAUDE_CONFIG_DIR: `/config/claude`, XDG_DATA_HOME: `/data` },
            read_file: async path => { paths.push( path ); return `{}` },
            run: async ( command, args ) => {
                commands.push( [ command, ...args ] )
                return { stdout: args.includes( `Claude Code-credentials` )
                    ? JSON.stringify( { claudeAiOauth: { accessToken: `secret` } } )
                    : `go-keyring-base64:${ Buffer.from( JSON.stringify( { access_token: `agy-secret` } ) ).toString( `base64` ) }` }
            },
        } )
        expect( paths ).toContain( `/host/alice/custom-codex/auth.json` )
        expect( paths ).toContain( `/data/opencode/auth.json` )
        expect( auth.claude.claudeAiOauth.accessToken ).toBe( `secret` )
        expect( auth.antigravity.access_token ).toBe( `agy-secret` )
        expect( commands.every( command => command[0] === `security` ) ).toBe( true )
    } )

    it( `returns JSON and an explicit partial-failure status`, async () => {
        let output = ``
        const code = await run_usage( [ `--json` ], {
            codex_read: no_codex, credentials: { env: { ANTHROPIC_API_KEY: `secret` } },
            output: { write: text => { output += text } },
        } )
        expect( code ).toBe( 1 )
        expect( JSON.parse( output ).agents[0].status ).toBe( `unavailable` )
        expect( output ).not.toContain( `secret` )
    } )

    it( `discovers keyring-only Codex accounts and environment-only OpenRouter`, async () => {
        const report = await collect_usage( {
            credentials: { env: { OPENROUTER_API_KEY: `secret` } },
            codex_read: async () => ( { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300 } } } ),
            fetch_fn: async () => response( { data: { usage: 0, limit: null } } ),
        } )
        expect( report.agents.find( agent => agent.agent === `codex` ).status ).toBe( `ok` )
        expect( report.agents.find( agent => agent.provider === `openrouter` ).status ).toBe( `ok` )
    } )

    it( `help does not read credentials or start an authentication process`, async () => {
        let output = ``
        const code = await run_usage( [ `--help` ], {
            discover: () => { throw new Error( `must not run` ) },
            output: { write: text => { output += text } },
        } )
        expect( code ).toBe( 0 )
        expect( output ).toContain( `Usage: babysit usage` )
    } )

    it( `does not echo provider network exceptions or follow credential redirects`, async () => {
        let redirect
        try {
            await provider_request( `https://example.test`, `secret`, { fetch_fn: async ( url, options ) => {
                redirect = options.redirect
                throw new Error( `secret` )
            } } )
        } catch ( error ) {
            expect( error.message ).not.toContain( `secret` )
        }
        expect( redirect ).toBe( `error` )
    } )

    it( `runs the standalone command outside a session with an empty home`, () => {
        const home = mkdtempSync( join( tmpdir(), `babysit-usage-` ) )
        try {
            const result = spawnSync( process.execPath, [ `src/docker/assets/usage/bin.mjs`, `--json` ], {
                cwd: process.cwd(), env: { HOME: home, PATH: process.env.PATH }, encoding: `utf8`,
            } )
            expect( result.status ).toBe( 0 )
            const report = JSON.parse( result.stdout )
            expect( report.agents ).toHaveLength( 4 )
            expect( report.agents.every( agent => agent.status === `unauthenticated` ) ).toBe( true )
        } finally { rmSync( home, { recursive: true, force: true } ) }
    } )

    it( `speaks the native Codex stdio protocol with no model turn`, async () => {
        const home = mkdtempSync( join( tmpdir(), `babysit-usage-rpc-` ) )
        try {
            mkdirSync( join( home, `bin` ) )
            writeFileSync( join( home, `bin`, `codex` ), `#!/usr/bin/env node\nprocess.stdin.setEncoding('utf8');let b='';process.stdin.on('data',c=>{b+=c;while(b.includes('\\n')){const i=b.indexOf('\\n');const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);if(m.method==='initialize')console.log(JSON.stringify({id:m.id,result:{}}));else if(m.method==='account/read')console.log(JSON.stringify({id:m.id,result:{account:{type:'chatgpt'}}}));else if(m.method==='account/rateLimits/read')console.log(JSON.stringify({id:m.id,result:{rateLimits:{primary:{usedPercent:42,windowDurationMins:300}}}}));else if(m.method!=='initialized')process.exit(9)}});\n`, { mode: 0o755 } )
            const result = await read_codex_limits( { env: { ...process.env, BABYSIT_EFFORT_AGENT: ``, PATH: `${ join( home, `bin` ) }:${ process.env.PATH }` } } )
            expect( result.rateLimits.primary.usedPercent ).toBe( 42 )
        } finally { rmSync( home, { recursive: true, force: true } ) }
    } )

} )
