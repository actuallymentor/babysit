import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { is_newer_version, newer_version_available, fetch_latest_version, VERSION_CHECK_TTL_MS } from '../src/cli/version_check.js'

const temp_cache = () => join( mkdtempSync( join( tmpdir(), `babysit-version-` ) ), `latest-version.json` )

describe( `version check`, () => {

    it( `compares versions numerically`, () => {
        expect( is_newer_version( `1.10.0`, `1.9.9` ) ).toBe( true )
        expect( is_newer_version( `v2.0.0`, `1.99.0` ) ).toBe( true )
        expect( is_newer_version( `1.2.0`, `1.2.0` ) ).toBe( false )
        expect( is_newer_version( `1.2`, `1.2.1` ) ).toBe( false )
        expect( is_newer_version( `nope`, `1.0.0` ) ).toBe( false )
    } )

    it( `answers from the cache and refreshes it in the background when stale`, async () => {
        const cache_path = temp_cache()
        const now = Date.now()
        let fetches = 0
        const fetch_latest = async () => {
            fetches++; return `9.9.9` 
        }

        // Empty cache: nothing to report yet, one fetch starts.
        const first = newer_version_available( { current: `1.0.0`, cache_path, fetch_latest, now } )
        expect( first.latest ).toBeNull()
        await first.refresh
        expect( fetches ).toBe( 1 )
        expect( JSON.parse( readFileSync( cache_path, `utf8` ) ) ).toEqual( { latest: `9.9.9`, checked_at: now } )

        // Fresh cache: reports without fetching.
        const second = newer_version_available( { current: `1.0.0`, cache_path, fetch_latest, now: now + 1_000 } )
        expect( second.latest ).toBe( `9.9.9` )
        expect( second.refresh ).toBeNull()
        expect( newer_version_available( { current: `9.9.9`, cache_path, fetch_latest, now: now + 1_000 } ).latest ).toBeNull()

        // Stale cache: still answers from it, and refreshes again.
        const third = newer_version_available( { current: `1.0.0`, cache_path, fetch_latest, now: now + VERSION_CHECK_TTL_MS + 1 } )
        expect( third.latest ).toBe( `9.9.9` )
        await third.refresh
        expect( fetches ).toBe( 2 )
        rmSync( cache_path, { force: true } )
    } )

    it( `records a failed attempt so listings do not retry every time`, async () => {
        const cache_path = temp_cache()
        const now = Date.now()
        const { refresh } = newer_version_available( { current: `1.0.0`, cache_path, fetch_latest: async () => null, now } )
        await refresh
        expect( JSON.parse( readFileSync( cache_path, `utf8` ) ) ).toEqual( { checked_at: now } )
        expect( newer_version_available( { current: `1.0.0`, cache_path, fetch_latest: async () => `2.0.0`, now: now + 1 } ).refresh ).toBeNull()
    } )

    it( `tolerates a corrupt cache file`, () => {
        const cache_path = temp_cache()
        writeFileSync( cache_path, `{not json` )
        expect( newer_version_available( { current: `1.0.0`, cache_path, fetch_latest: async () => null } ).latest ).toBeNull()
    } )

    it( `fetches the tag and swallows network or API failures`, async () => {
        expect( await fetch_latest_version( { fetch_fn: async () => ( { ok: true, json: async () => ( { tag_name: `v1.5.0` } ) } ) } ) ).toBe( `1.5.0` )
        expect( await fetch_latest_version( { fetch_fn: async () => ( { ok: false } ) } ) ).toBeNull()
        expect( await fetch_latest_version( { fetch_fn: async () => {
            throw new Error( `offline` ) 
        } } ) ).toBeNull()
    } )

} )
