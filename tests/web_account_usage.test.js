import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ACCOUNT_USAGE_FILENAME, refresh_account_usage } from '../src/web_bridge/account_usage.js'
import { initialize_web_bridge } from '../src/web_bridge/init.js'

const temporary_directories = []

const make_bridge = () => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-web-usage-test-` ) )
    temporary_directories.push( directory )
    initialize_web_bridge( { directory } )
    return { directory, path: join( directory, `state`, ACCOUNT_USAGE_FILENAME ) }
}

const report = {
    fetched_at: `2026-10-13T12:00:00.000Z`,
    agents: [ {
        agent: `claude`,
        provider: `anthropic`,
        fetched_at: `2026-10-13T12:00:00.000Z`,
        status: `ok`,
        source: `Claude OAuth usage`,
        access_token: `must-not-leak`,
        limits: [ { name: `session\u0000 / 5h`, used_percent: 42, resets_at: `2026-10-13T15:00:00Z`, secret: `nope` } ],
    } ],
}

afterEach( () => {
    temporary_directories.splice( 0 ).forEach( directory => rmSync( directory, { recursive: true, force: true } ) )
} )

describe( `web account usage`, () => {

    it( `writes an allowlisted document without host-only fields`, async () => {
        const { directory, path } = make_bridge()
        let options = null

        expect( await refresh_account_usage( { directory, collect: async received => {
            options = received
            return report
        } } ) ).toBe( true )

        const written = readFileSync( path, `utf8` )
        expect( written ).not.toContain( `must-not-leak` )
        expect( written ).not.toContain( `nope` )
        expect( JSON.parse( written ) ).toEqual( {
            protocol: 1,
            kind: `account_usage`,
            fetched_at: report.fetched_at,
            agents: [ {
                agent: `claude`,
                provider: `anthropic`,
                status: `ok`,
                message: null,
                limits: [ {
                    name: `session / 5h`,
                    unit: null,
                    used_percent: 42,
                    remaining_percent: null,
                    used: null,
                    limit: null,
                    remaining: null,
                    unlimited: false,
                    resets_at: `2026-10-13T15:00:00Z`,
                } ],
            } ],
        } )
        expect( await options.codex_read() ).toBeNull()
        expect( existsSync( `${ path }.lock` ) ).toBe( false )
    } )

    it( `skips fresh files and concurrent refreshes, retries after the window`, async () => {
        const { directory, path } = make_bridge()
        let calls = 0
        const collect = async () => {
            calls += 1
            return report
        }

        await refresh_account_usage( { directory, collect } )
        expect( await refresh_account_usage( { directory, collect } ) ).toBe( false )

        utimesSync( path, new Date( 0 ), new Date( 0 ) )
        writeFileSync( `${ path }.lock`, `` )
        expect( await refresh_account_usage( { directory, collect } ) ).toBe( false )

        utimesSync( `${ path }.lock`, new Date( 0 ), new Date( 0 ) )
        expect( await refresh_account_usage( { directory, collect } ) ).toBe( true )
        expect( calls ).toBe( 2 )
    } )

    it( `keeps the previous file when collection fails`, async () => {
        const { directory, path } = make_bridge()
        await refresh_account_usage( { directory, collect: async () => report } )
        utimesSync( path, new Date( 0 ), new Date( 0 ) )

        const failing = async () => {
            throw new Error( `offline` )
        }
        expect( await refresh_account_usage( { directory, collect: failing } ) ).toBe( false )
        expect( JSON.parse( readFileSync( path, `utf8` ) ).agents[0].agent ).toBe( `claude` )

        // The failed attempt's lock is the retry cooldown until it goes stale
        expect( existsSync( `${ path }.lock` ) ).toBe( true )
        expect( await refresh_account_usage( { directory, collect: async () => report } ) ).toBe( false )
        utimesSync( `${ path }.lock`, new Date( 0 ), new Date( 0 ) )
        expect( await refresh_account_usage( { directory, collect: async () => report } ) ).toBe( true )
    } )

    it( `never releases a lock another monitor took over`, async () => {
        const { directory, path } = make_bridge()
        await refresh_account_usage( { directory, collect: async () => {
            writeFileSync( `${ path }.lock`, `someone-else` )
            return report
        } } )

        expect( readFileSync( `${ path }.lock`, `utf8` ) ).toBe( `someone-else` )
    } )

} )
