import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { alert_high_usage, alert_logouts, notify_pushover, pushover_configured, used_percent } from '../src/utils/notify.js'

const ENV = { PUSHOVER_TOKEN: `app-token`, PUSHOVER_USER: `user-key` }

const usage = limits => ( { agents: [ { agent: `claude`, provider: `anthropic`, status: `ok`, limits } ] } )

describe( `pushover`, () => {

    it( `is a no-op without both credentials`, async () => {

        const calls = []
        const fetch_fn = async ( ...args ) => calls.push( args )

        expect( pushover_configured( {} ) ).toBe( false )
        expect( pushover_configured( { PUSHOVER_TOKEN: `x` } ) ).toBe( false )
        expect( await notify_pushover( { title: `t`, message: `m` }, { env: { PUSHOVER_USER: `u` }, fetch_fn } ) ).toBe( false )
        expect( calls ).toEqual( [] )

    } )

    it( `posts form data and never throws on failure`, async () => {

        const calls = []
        const ok = await notify_pushover( { title: `Title`, message: `Body` }, {
            env: ENV,
            fetch_fn: async ( url, options ) => {
                calls.push( { url, body: Object.fromEntries( options.body ) } )
                return { ok: true }
            },
        } )

        expect( ok ).toBe( true )
        expect( calls ).toEqual( [ {
            url: `https://api.pushover.net/1/messages.json`,
            body: { token: `app-token`, user: `user-key`, title: `Title`, message: `Body` },
        } ] )

        const offline = async () => {
            throw new Error( `offline` )
        }
        expect( await notify_pushover( { title: `t`, message: `m` }, { env: ENV, fetch_fn: offline } ) ).toBe( false )
        expect( await notify_pushover( { title: `t`, message: `m` }, { env: ENV, fetch_fn: async () => ( { ok: false, status: 400 } ) } ) ).toBe( false )

    } )

} )

describe( `usage alerts`, () => {

    let directory
    let alerts_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-usage-alerts-` ) )
        alerts_path = join( directory, `alerts.json` )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    const run = ( limits, delivered = true ) => {
        const sent = []
        const notify = async message => {
            sent.push( message )
            return delivered
        }
        return alert_high_usage( usage( limits ), { alerts_path, notify } ).then( keys => ( { keys, sent } ) )
    }

    it( `reads used or remaining percentages`, () => {

        expect( used_percent( { used_percent: 42 } ) ).toBe( 42 )
        expect( used_percent( { remaining_percent: 5 } ) ).toBe( 95 )
        expect( used_percent( { unit: `USD`, used: 19, limit: 20 } ) ).toBe( 95 )
        expect( used_percent( { unit: `USD`, used: 3 } ) ).toBeNull()

    } )

    it( `notifies once per window at 90% and re-arms on reset or recovery`, async () => {

        const weekly = { name: `weekly`, used_percent: 91, resets_at: `2026-10-12T15:59:00Z` }

        const first = await run( [ weekly, { name: `session`, used_percent: 89.9 } ] )
        expect( first.keys ).toEqual( [ `claude/anthropic/weekly` ] )
        expect( first.sent[0].title ).toBe( `Babysit: claude usage at 91%` )
        expect( first.sent[0].message ).toContain( `resets 2026-10-12T15:59:00Z` )

        // Same window: silent
        expect( ( await run( [ { ...weekly, used_percent: 99 } ] ) ).keys ).toEqual( [] )

        // New window: alerts again
        expect( ( await run( [ { ...weekly, resets_at: `2026-10-19T15:59:00Z` } ] ) ).keys ).toEqual( [ `claude/anthropic/weekly` ] )

        // Dropping below the threshold forgets it, so the next crossing alerts
        await run( [ { ...weekly, resets_at: `2026-10-19T15:59:00Z`, used_percent: 10 } ] )
        expect( JSON.parse( readFileSync( alerts_path, `utf8` ) ).usage ).toEqual( {} )
        expect( ( await run( [ { ...weekly, resets_at: `2026-10-19T15:59:00Z` } ] ) ).keys ).toEqual( [ `claude/anthropic/weekly` ] )

    } )

    it( `retries undelivered alerts on the next run`, async () => {

        const limit = { name: `five_hour`, used_percent: 95, resets_at: `2026-10-09T20:00:00Z` }
        expect( ( await run( [ limit ], false ) ).keys ).toEqual( [] )
        expect( ( await run( [ limit ] ) ).keys ).toEqual( [ `claude/anthropic/five_hour` ] )

    } )

    it( `keeps a failed provider's windows so its recovery does not repeat the alert`, async () => {

        const weekly = { name: `weekly`, used_percent: 95, resets_at: `2026-10-12T15:59:00Z` }
        await run( [ weekly ] )

        const failed = { agents: [ { agent: `claude`, provider: `anthropic`, status: `error`, limits: [] } ] }
        expect( await alert_high_usage( failed, { alerts_path, notify: async () => true } ) ).toEqual( [] )
        expect( ( await run( [ weekly ] ) ).keys ).toEqual( [] )

    } )

} )

describe( `logout alerts`, () => {

    let directory
    let alerts_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-logout-alerts-` ) )
        alerts_path = join( directory, `alerts.json` )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    it( `alerts once per lost login, retries until delivered, and re-arms on a new login`, async () => {

        const titles = []
        let up = false
        const notify = async message => {
            titles.push( message.title )
            return up
        }

        // Pushover down: kept pending, retried next run even with no new logouts
        expect( await alert_logouts( [ { agent: `codex`, login: `2026-10-09T08:00:00Z` } ], { alerts_path, notify } ) ).toEqual( [] )
        up = true
        expect( await alert_logouts( [], { alerts_path, notify } ) ).toEqual( [ `codex` ] )
        expect( titles ).toEqual( [ `Babysit: codex logged out`, `Babysit: codex logged out` ] )

        // The same dead login probed again stays silent
        expect( await alert_logouts( [ { agent: `codex`, login: `2026-10-09T08:00:00Z` } ], { alerts_path, notify } ) ).toEqual( [] )

        // A later login that is lost again alerts again
        expect( await alert_logouts( [ { agent: `codex`, login: `2026-10-10T08:00:00Z` } ], { alerts_path, notify } ) ).toEqual( [ `codex` ] )

    } )

    it( `shares the state file with usage alerts without clobbering it`, async () => {

        await alert_logouts( [ { agent: `claude`, login: `a` } ], { alerts_path, notify: async () => true } )
        await alert_high_usage( usage( [ { name: `weekly`, used_percent: 99, resets_at: `r` } ] ), { alerts_path, notify: async () => true } )

        expect( JSON.parse( readFileSync( alerts_path, `utf8` ) ) ).toEqual( {
            usage: { 'claude/anthropic/weekly': `r` },
            logouts: { claude: { login: `a`, delivered: true } },
        } )

    } )

} )
