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

        const weekly = { name: `weekly`, used_percent: 91, resets_at: `2099-10-12T15:59:00Z` }

        const first = await run( [ weekly, { name: `session`, used_percent: 89.9 } ] )
        expect( first.keys ).toEqual( [ `claude/anthropic/weekly` ] )
        expect( first.sent[0].title ).toBe( `Babysit: claude usage at 91%` )
        expect( first.sent[0].message ).toContain( `resets 2099-10-12T15:59:00Z` )

        // Same window: silent
        expect( ( await run( [ { ...weekly, used_percent: 99 } ] ) ).keys ).toEqual( [] )

        // New window: alerts again
        expect( ( await run( [ { ...weekly, resets_at: `2099-10-19T15:59:00Z` } ] ) ).keys ).toEqual( [ `claude/anthropic/weekly` ] )

        // A dip below the threshold in the same window stays silent
        await run( [ { ...weekly, resets_at: `2099-10-19T15:59:00Z`, used_percent: 10 } ] )
        expect( ( await run( [ { ...weekly, resets_at: `2099-10-19T15:59:00Z` } ] ) ).keys ).toEqual( [] )

        // An open window (no reset time) re-arms once it drops below
        const credits = { name: `credits`, used_percent: 95 }
        expect( ( await run( [ credits ] ) ).keys ).toEqual( [ `claude/anthropic/credits` ] )
        await run( [ { ...credits, used_percent: 10 } ] )
        expect( ( await run( [ credits ] ) ).keys ).toEqual( [ `claude/anthropic/credits` ] )

    } )

    it( `treats Claude's drifting reset stamps as one window`, async () => {

        // Real consecutive reads: the stamp drifts across a second boundary
        const session = { name: `session`, used_percent: 100, resets_at: `2026-10-11T11:39:59.582961+00:00` }
        expect( ( await run( [ session ] ) ).keys ).toEqual( [ `claude/anthropic/session` ] )
        expect( ( await run( [ { ...session, resets_at: `2026-10-11T11:40:00.381124+00:00` } ] ) ).keys ).toEqual( [] )
        // The next five-hour window does alert
        expect( ( await run( [ { ...session, resets_at: `2026-10-11T16:40:00.1+00:00` } ] ) ).keys ).toEqual( [ `claude/anthropic/session` ] )

    } )

    it( `sends one push per run however many limits crossed`, async () => {

        const { keys, sent } = await run( [
            { name: `session`, used_percent: 100, resets_at: `2026-10-11T11:40:00Z` },
            { name: `weekly_all`, used_percent: 93, resets_at: `2026-10-12T16:00:00Z` },
        ] )
        expect( keys ).toEqual( [ `claude/anthropic/session`, `claude/anthropic/weekly_all` ] )
        expect( sent ).toHaveLength( 1 )
        expect( sent[0].title ).toBe( `Babysit: claude usage at 100%` )
        expect( sent[0].message.split( `\n` ) ).toHaveLength( 2 )

    } )

    it( `forgets a window once it has reset`, async () => {

        await alert_high_usage( usage( [ { name: `session`, used_percent: 95, resets_at: `2026-10-11T11:40:00Z` } ] ), { alerts_path, notify: async () => true, now: Date.parse( `2026-10-11T10:00:00Z` ) } )
        await alert_high_usage( usage( [] ), { alerts_path, notify: async () => true, now: Date.parse( `2026-10-11T12:00:00Z` ) } )
        expect( JSON.parse( readFileSync( alerts_path, `utf8` ) ).usage ).toEqual( {} )

    } )

    it( `retries undelivered alerts on the next run`, async () => {

        const limit = { name: `five_hour`, used_percent: 95, resets_at: `2026-10-09T20:00:00Z` }
        expect( ( await run( [ limit ], false ) ).keys ).toEqual( [] )
        expect( ( await run( [ limit ] ) ).keys ).toEqual( [ `claude/anthropic/five_hour` ] )

    } )

    it( `keeps a failed provider's windows so its recovery does not repeat the alert`, async () => {

        // Reset a day out: a fixed stamp turns into a reset window once that time passes
        const weekly = { name: `weekly`, used_percent: 95, resets_at: new Date( Date.now() + 86_400_000 ).toISOString() }
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

    it( `names the evidence and drops a pending alert once the agent re-verifies`, async () => {

        const messages = []
        let up = false
        const notify = async message => {
            messages.push( message.message )
            return up
        }

        await alert_logouts( [ { agent: `claude`, login: `2026-10-09T08:00:00Z`, reason: `its refresh token expired` } ], { alerts_path, notify } )
        expect( messages[0] ).toBe( `claude was authenticated but its refresh token expired. Log in again on the host.` )

        // Fixed before Pushover came back: nothing stale goes out
        up = true
        expect( await alert_logouts( [], { alerts_path, notify, recovered: [ `claude` ] } ) ).toEqual( [] )
        expect( messages ).toHaveLength( 1 )

    } )

    it( `ends with the fix the checker names, else a host login`, async () => {

        const messages = []
        await alert_logouts( [ { agent: `claude`, login: `x`, reason: `the host CLI reports it logged out`, fix: `Run babysit auth init --claude-token on the host.` } ], {
            alerts_path, notify: async message => messages.push( message.message ),
        } )
        expect( messages ).toEqual( [ `claude was authenticated but the host CLI reports it logged out. Run babysit auth init --claude-token on the host.` ] )

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
