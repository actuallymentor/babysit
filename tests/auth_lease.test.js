import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
    HOST_AUTH_LEASE_STALE_MS,
    acquire_host_auth_lease,
    is_host_auth_lease_wanted,
} from '../src/agents/auth_lease.js'

describe( `host authentication lease`, () => {

    let directory
    let lease_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-auth-lease-` ) )
        lease_path = join( directory, `auth.lease` )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `makes a concurrent launch wait for credential reconciliation`, async () => {

        const first = await acquire_host_auth_lease( { lease_path } )
        let second_acquired = false
        const second_task = acquire_host_auth_lease( {
            lease_path,
            poll_ms: 1,
        } ).then( lease => {
            second_acquired = true
            return lease
        } )

        await new Promise( resolve => setTimeout( resolve, 5 ) )
        expect( second_acquired ).toBe( false )

        expect( first.release() ).toBe( true )
        const second = await second_task
        expect( second_acquired ).toBe( true )
        expect( second.release() ).toBe( true )
        expect( existsSync( lease_path ) ).toBe( false )

    } )

    it( `takes over a lease whose owner process exited`, async () => {

        mkdirSync( lease_path )
        writeFileSync( join( lease_path, `owner.json` ), JSON.stringify( {
            pid: 123_456,
            token: `dead-owner`,
        } ) )

        const lease = await acquire_host_auth_lease( {
            lease_path,
            kill: () => {
                const error = new Error( `missing` )
                error.code = `ESRCH`
                throw error
            },
        } )

        expect( lease.release() ).toBe( true )

    } )

    it( `bounds waiting behind a live owner`, async () => {

        mkdirSync( lease_path )
        writeFileSync( join( lease_path, `owner.json` ), JSON.stringify( {
            pid: process.pid,
            token: `live-owner`,
        } ) )
        let current = 0

        await expect( acquire_host_auth_lease( {
            lease_path,
            timeout_ms: 5,
            poll_ms: 2,
            now: () => current,
            wait_fn: async milliseconds => { current += milliseconds },
            kill: () => {},
        } ) ).rejects.toThrow( `Timed out waiting for another authentication check` )

    } )

    it( `never reclaims an old lease while its owner is alive`, async () => {

        mkdirSync( lease_path )
        writeFileSync( join( lease_path, `owner.json` ), JSON.stringify( {
            pid: process.pid,
            token: `live-owner`,
        } ) )
        const old = new Date( Date.now() - HOST_AUTH_LEASE_STALE_MS * 2 )
        utimesSync( lease_path, old, old )
        let current = Date.now()

        await expect( acquire_host_auth_lease( {
            lease_path,
            timeout_ms: 5,
            poll_ms: 2,
            now: () => current,
            wait_fn: async milliseconds => { current += milliseconds },
            kill: () => {},
        } ) ).rejects.toThrow( `Timed out waiting for another authentication check` )

        expect( JSON.parse( readFileSync( join( lease_path, `owner.json` ) ) ).token )
            .toBe( `live-owner` )

    } )

} )

describe( `host authentication lease visibility`, () => {

    let directory
    let lease_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-auth-lease-wait-` ) )
        lease_path = join( directory, `auth.lease` )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `announces a wait once and marks the lease wanted until acquired`, async () => {

        const first = await acquire_host_auth_lease( { lease_path } )
        let waits = 0
        let wanted_while_waiting = null
        const second_task = acquire_host_auth_lease( {
            lease_path,
            poll_ms: 1,
            on_wait: () => waits += 1,
        } )

        await new Promise( resolve => setTimeout( resolve, 10 ) )
        wanted_while_waiting = is_host_auth_lease_wanted( { lease_path } )
        expect( first.release() ).toBe( true )
        const second = await second_task

        expect( waits ).toBe( 1 )
        expect( wanted_while_waiting ).toBe( true )
        expect( is_host_auth_lease_wanted( { lease_path } ) ).toBe( false )
        expect( second.release() ).toBe( true )

    } )

    it( `lets a background check give up immediately without flagging a wait`, async () => {

        const first = await acquire_host_auth_lease( { lease_path } )

        await expect( acquire_host_auth_lease( {
            lease_path,
            timeout_ms: 0,
            foreground: false,
        } ) ).rejects.toThrow( `Timed out waiting for another authentication check` )
        expect( is_host_auth_lease_wanted( { lease_path } ) ).toBe( false )
        expect( first.release() ).toBe( true )

    } )

} )
