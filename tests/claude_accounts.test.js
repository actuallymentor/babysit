import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
    account_credential_mounts,
    account_headroom,
    account_usage_report,
    cached_account_usage,
    cmd_auth_accounts,
    list_claude_accounts,
    pick_account,
    probe_accounts,
    read_account_registry,
    remove_account,
    resolve_launch_account,
    save_account,
    validate_account_name,
} from '../src/cli/claude_accounts.js'
import { collect_usage } from '../src/docker/assets/usage/command.mjs'
import { format_usage } from '../src/docker/assets/usage/format.mjs'
import { setup_claude_token } from '../src/cli/claude_token.js'
import { credential_mounts_for_agent, fingerprint_agent_credentials } from '../src/agents/auth_cache.js'
import { claude } from '../src/agents/claude.js'

const WORK = `sk-ant-oat01-work-token`
const HOME = `sk-ant-oat01-home-token`
const RC = `sk-ant-oat01-rc-token`

const scratch = () => {
    const dir = mkdtempSync( join( tmpdir(), `babysit-accounts-` ) )
    return { dir, path: join( dir, `state`, `claude-accounts.json` ), usage_path: join( dir, `state`, `claude-account-usage.json` ), rc_path: join( dir, `.babysitrc` ) }
}

const limits = ( session, weekly ) => [
    { name: `session`, used_percent: session, resets_at: `2026-10-17T15:00:00.000Z` },
    { name: `weekly_all`, used_percent: weekly, resets_at: `2026-10-20T09:00:00.000Z` },
]

describe( `Claude account registry`, () => {

    it( `adds, replaces, lists and removes named tokens in a 0600 file`, () => {

        const { path, usage_path, rc_path } = scratch()
        save_account( `work`, WORK, { path, now: new Date( `2026-10-17T00:00:00Z` ) } )
        save_account( `home`, `sk-ant-oat01-old`, { path } )
        save_account( `home`, HOME, { path } )

        expect( statSync( path ).mode & 0o777 ).toBe( 0o600 )
        expect( read_account_registry( { path } ).accounts.work ).toEqual( {
            token: WORK, added_at: `2026-10-17T00:00:00.000Z`, expires_at: `2027-10-17T00:00:00.000Z`,
        } )
        expect( list_claude_accounts( { env: {}, path, rc_path } ).map( ( { name, token } ) => [ name, token ] ) ).toEqual( [ [ `work`, WORK ], [ `home`, HOME ] ] )

        expect( remove_account( `home`, { path, usage_path } ) ).toBe( true )
        expect( remove_account( `home`, { path, usage_path } ) ).toBe( false )
        expect( list_claude_accounts( { env: {}, path, rc_path } ).map( ( { name } ) => name ) ).toEqual( [ `work` ] )

    } )

    it( `keeps the ~/.babysitrc token as the implicit default account, first`, () => {

        const { path, rc_path } = scratch()
        writeFileSync( rc_path, `# Claude setup-token from babysit auth init, 2026-10-10; expires ~2027-10-10\nexport CLAUDE_CODE_OAUTH_TOKEN=${ RC }\n` )
        save_account( `work`, WORK, { path } )
        // The same subscription registered twice is one account
        save_account( `again`, RC, { path } )

        const accounts = list_claude_accounts( { env: { CLAUDE_CODE_OAUTH_TOKEN: RC }, path, rc_path } )
        expect( accounts.map( ( { name } ) => name ) ).toEqual( [ `default`, `work` ] )
        expect( accounts[ 0 ] ).toMatchObject( { token: RC, added_at: `2026-10-10`, expires_at: `2027-10-10` } )

    } )

    it( `rejects unsafe names and the reserved default`, () => {
        expect( () => validate_account_name( `work-2.alt_x` ) ).not.toThrow()
        for( const name of [ ``, `-x`, `a b`, `a/b`, `$(id)`, `x`.repeat( 33 ) ] ) expect( () => validate_account_name( name ) ).toThrow()
        const { path } = scratch()
        expect( () => save_account( `default`, WORK, { path } ) ).toThrow( /babysitrc/ )
    } )

    it( `survives a missing or corrupt registry`, () => {
        const { path } = scratch()
        expect( read_account_registry( { path } ) ).toEqual( { version: 1, accounts: {} } )
        writeFileSync( path.replace( `/state`, `` ), `{nope` )
        expect( read_account_registry( { path: path.replace( `/state`, `` ) } ) ).toEqual( { version: 1, accounts: {} } )
    } )

} )

describe( `headroom selection`, () => {

    it( `headroom is the tightest window`, () => {
        expect( account_headroom( limits( 30, 80 ) ) ).toBe( 20 )
        expect( account_headroom( limits( 100, 10 ) ) ).toBe( 0 )
        expect( account_headroom( [ { name: `x`, used_percent: null } ] ) ).toBe( null )
    } )

    it( `picks the most headroom, keeps list order on ties, never an unreadable account`, () => {
        const readings = [
            { name: `default`, status: `ok`, headroom: 40 },
            { name: `work`, status: `error`, headroom: null },
            { name: `home`, status: `ok`, headroom: 70 },
            { name: `spare`, status: `ok`, headroom: 70 },
        ]
        expect( pick_account( readings ).name ).toBe( `home` )
        expect( pick_account( readings.slice( 0, 2 ) ).name ).toBe( `default` )
        expect( pick_account( [ readings[ 1 ] ] ) ).toBe( null )
    } )

    const accounts = [ { name: `default`, token: RC }, { name: `work`, token: WORK } ]

    it( `launch: --account forces, a resumed session keeps its account, else most headroom`, async () => {

        let probes = 0
        const probe = async () => ++probes && [
            { name: `default`, status: `ok`, headroom: 5 },
            { name: `work`, status: `ok`, headroom: 60 },
        ]
        const seams = { list: () => accounts, probe }

        expect( ( await resolve_launch_account( { requested: `default` }, seams ) ).account.name ).toBe( `default` )
        expect(  await resolve_launch_account( { stored: `default` }, seams )  ).toMatchObject( { account: { name: `default` }, reason: `resumed` } )
        expect( probes ).toBe( 0 )

        expect(  await resolve_launch_account( {}, seams )  ).toMatchObject( { account: { name: `work` }, reason: `most headroom (60% left)` } )
        // A removed account falls back to selection
        expect( ( await resolve_launch_account( { stored: `gone` }, seams ) ).account.name ).toBe( `work` )
        await expect( resolve_launch_account( { requested: `nope` }, seams ) ).rejects.toThrow( /Unknown Claude account "nope"/ )

    } )

    it( `launch: one account changes nothing and spends no probe`, async () => {
        const probe = async () => {
            throw new Error( `must not probe` )
        }
        expect( await resolve_launch_account( {}, { list: () => accounts.slice( 0, 1 ), probe } ) ).toEqual( { account: null, reason: `single account` } )
    } )

    it( `only a named account gets a staged credential, never the default`, () => {
        expect( account_credential_mounts( null ) ).toEqual( [] )
        expect( account_credential_mounts( { name: `default`, token: RC } ) ).toEqual( [] )
        expect( account_credential_mounts( { name: `work`, token: WORK } ) ).toEqual( [ { type: `account_env`, key: `CLAUDE_CODE_OAUTH_TOKEN`, value: WORK, account: `work` } ] )
    } )

    it( `the staged account token reaches Claude's probe and keys its auth cache`, () => {
        const default_env = { type: `env`, key: `CLAUDE_CODE_OAUTH_TOKEN`, value: RC }
        const [ work ] = account_credential_mounts( { name: `work`, token: WORK } )
        expect( credential_mounts_for_agent( claude, [ default_env, work ] ) ).toEqual( [ default_env, work ] )
        expect( fingerprint_agent_credentials( claude, [ default_env, work ] ) ).not.toEqual( fingerprint_agent_credentials( claude, [ default_env ] ) )
    } )

} )

describe( `account usage cache`, () => {

    const accounts = [ { name: `default`, token: RC }, { name: `work`, token: WORK } ]

    it( `reuses readings younger than the TTL and never stores tokens`, async () => {

        const { usage_path: cache_path } = scratch()
        const asked = []
        const request = async token => asked.push( token ) && limits( token === WORK ? 20 : 90, 10 )
        let clock = Date.parse( `2026-10-17T12:00:00Z` )
        const now = () => clock

        const first = await probe_accounts( accounts, { request, cache_path, now } )
        expect( first.map( ( { name, headroom } ) => [ name, headroom ] ) ).toEqual( [ [ `default`, 10 ], [ `work`, 80 ] ] )
        expect( statSync( cache_path ).mode & 0o777 ).toBe( 0o600 )
        expect( readFileSync( cache_path, `utf8` ) ).not.toContain( `sk-ant` )

        clock += 4 * 60_000
        await probe_accounts( accounts, { request, cache_path, now } )
        expect( asked.length ).toBe( 2 )

        clock += 2 * 60_000
        await probe_accounts( accounts, { request, cache_path, now } )
        expect( asked.length ).toBe( 4 )

        // max_age 0 always buys a fresh reading
        await probe_accounts( accounts, { request, cache_path, now, max_age_ms: 0 } )
        expect( asked.length ).toBe( 6 )

        expect( cached_account_usage( { cache_path } ).work ).toMatchObject( { headroom: 80 } )

    } )

    it( `a replaced token invalidates its reading; errors are reported, not cached`, async () => {

        const { usage_path: cache_path } = scratch()
        const asked = []
        const ok = async token => asked.push( token ) && limits( 50, 50 )
        await probe_accounts( accounts, { request: ok, cache_path } )
        await probe_accounts( [ accounts[ 0 ], { name: `work`, token: `sk-ant-oat01-new` } ], { request: ok, cache_path } )
        expect( asked ).toEqual( [ RC, WORK, `sk-ant-oat01-new` ] )

        const fail = async () => {
            throw new Error( `Claude returned HTTP 401 without usage headers` )
        }
        const { usage_path: fresh_cache } = scratch()
        const [ reading ] = await probe_accounts( accounts.slice( 1 ), { request: fail, cache_path: fresh_cache } )
        expect( reading ).toMatchObject( { name: `work`, status: `error`, headroom: null, message: expect.stringContaining( `401` ) } )
        expect( cached_account_usage( { cache_path: fresh_cache } ) ).toEqual( {} )

    } )

    it( `usage report: one claude entry per account, labelled claude / <account>`, async () => {

        const probe = async list => list.map( ( { name } ) => ( { name, status: `ok`, limits: limits( 10, 20 ), headroom: 80, fetched_at: `2026-10-17T12:00:00.000Z` } ) )
        const report = await account_usage_report( { list: () => accounts, probe } )
        expect( report.agents.map( ( { agent, account } ) => `${ agent }:${ account }` ) ).toEqual( [ `claude:default`, `claude:work` ] )

        // collect_usage swaps its single Claude entry for the per-account ones
        const usage = await collect_usage( {
            credentials: { env: { CLAUDE_CODE_OAUTH_TOKEN: RC } },
            codex_read: async () => null,
            claude_accounts: async () => report.agents,
        } )
        const claude_rows = usage.agents.filter( ( { agent } ) => agent === `claude` )
        expect( claude_rows.map( ( { account } ) => account ) ).toEqual( [ `default`, `work` ] )
        const text = format_usage( usage, { env: { NO_COLOR: `1` } } )
        expect( text ).toContain( `claude / default` )
        expect( text ).toContain( `claude / work` )
        expect( text ).not.toContain( `claude / anthropic` )

    } )

    it( `usage: no hook result keeps the single Claude entry`, async () => {
        const usage = await collect_usage( { credentials: { env: {} }, codex_read: async () => null, claude_accounts: async () => null } )
        expect( usage.agents.filter( ( { agent } ) => agent === `claude` ) ).toEqual( [ expect.objectContaining( { provider: `anthropic`, status: `unauthenticated` } ) ] )
    } )

} )

describe( `babysit auth accounts`, () => {

    const output = () => {
        const chunks = []
        return { write: chunk => chunks.push( chunk ), text: () => chunks.join( `` ) }
    }

    it( `lists name, dates and last known headroom without printing tokens`, async () => {
        const out = output()
        const code = await cmd_auth_accounts( { auth_verb: `accounts` }, {
            output: out,
            list: () => [
                { name: `default`, token: RC, added_at: `2026-10-10`, expires_at: `2027-10-10` },
                { name: `work`, token: WORK, added_at: `2026-10-17T00:00:00.000Z`, expires_at: `2027-10-17T00:00:00.000Z` },
            ],
            usage: () => ( { work: { headroom: 42, fetched_at: new Date( Date.now() - 3 * 60_000 ).toISOString() } } ),
        } )
        expect( code ).toBe( 0 )
        expect( out.text() ).toContain( `NAME     ADDED       EXPIRES     HEADROOM` )
        expect( out.text() ).toContain( `work     2026-10-17  2027-10-17  42% left (3m ago)` )
        expect( out.text() ).toContain( `default  2026-10-10  2027-10-10  unknown` )
        expect( out.text() ).not.toContain( `sk-ant` )
    } )

    it( `removes a named account and refuses the rc default`, async () => {
        const removed = []
        const out = output()
        expect( await cmd_auth_accounts( { account_verb: `remove`, account_name: `work` }, { output: out, remove: name => removed.push( name ) > 0 } ) ).toBe( 0 )
        expect( await cmd_auth_accounts( { account_verb: `remove`, account_name: `default` }, { output: out, remove: name => removed.push( name ) > 0 } ) ).toBe( 1 )
        expect( removed ).toEqual( [ `work` ] )
        expect( out.text() ).toContain( `delete that block` )
    } )

    it( `auth init --claude-token --name saves to the registry, not the rc`, async () => {

        const env = { CLAUDE_CODE_OAUTH_TOKEN: RC }
        const named = []
        const out = output()
        const result = await setup_claude_token( { flags: { name: `work` } }, {
            input: { isTTY: true }, output: Object.assign( out, { isTTY: true } ), env,
            resolve_bin: () => `/usr/bin/claude`,
            setup: async () => true,
            paste: async () => WORK,
            verify: async () => ( { authenticated: true } ),
            save: () => {
                throw new Error( `must not touch the rc` )
            },
            save_named: async ( name, token ) => named.push( [ name, token ] ) && `/state/claude-accounts.json`,
        } )

        expect( result ).toBe( `saved` )
        expect( named ).toEqual( [ [ `work`, WORK ] ] )
        // The default route is untouched, even though a token was already present
        expect( env.CLAUDE_CODE_OAUTH_TOKEN ).toBe( RC )
        expect( out.text() ).toContain( `Saved Claude account "work"` )

    } )

} )
