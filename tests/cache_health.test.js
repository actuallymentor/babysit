import { describe, it, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BUILD_CACHE_WARN_BYTES, cache_warning, parse_build_cache_total, parse_docker_size, read_cache_health, refresh_cache_health } from '../src/docker/cache_health.js'

const temp_path = () => join( mkdtempSync( join( tmpdir(), `babysit-cache-health-` ) ), `docker-cache.json` )

const BUILDX_DU = [
    `ID                                          RECLAIMABLE  SIZE        LAST ACCESSED`,
    `wz1yd8a6n1a1x3s2b6c1r6v0f                   true         12.3GB      3 days ago`,
    `Shared:         4.1GB`,
    `Private:        137.2GB`,
    `Reclaimable:    235.4GB`,
    `Total:          235.4GB`,
].join( `\n` )

describe( `docker build cache health`, () => {

    it( `reads Docker's human sizes and the buildx du total`, () => {
        expect( parse_docker_size( `146.1GB` ) ).toBe( 146_100_000_000 )
        expect( parse_docker_size( `512MB` ) ).toBe( 512_000_000 )
        expect( parse_docker_size( `1.2kB` ) ).toBe( 1_200 )
        expect( parse_docker_size( `0B` ) ).toBe( 0 )
        expect( parse_docker_size( `lots` ) ).toBeNull()
        expect( parse_build_cache_total( BUILDX_DU ) ).toBe( 235_400_000_000 )
        expect( parse_build_cache_total( `no total here` ) ).toBeNull()
    } )

    it( `measures at most hourly, and one process at a time`, async () => {
        const path = temp_path()
        let clock = 0
        const calls = []
        const run_command = async ( command, args, options, timeout_ms ) => {
            calls.push( { args, timeout_ms } )
            return BUILDX_DU
        }
        const check = () => refresh_cache_health( { run_command, command_prefix: [ `docker` ], now: () => clock, path } )

        expect( await check() ).toEqual( { checked_at: 0, build_cache_bytes: 235_400_000_000 } )
        expect( calls ).toEqual( [ { args: [ `buildx`, `du` ], timeout_ms: 120_000 } ] )

        clock += 30 * 60_000
        await check()
        expect( calls.length ).toBe( 1 )

        clock += 31 * 60_000
        await check()
        expect( calls.length ).toBe( 2 )
    } )

    it( `keeps the last answer when a check fails, and retries after the claim expires`, async () => {
        const path = temp_path()
        let clock = 0
        let fail = false
        const run_command = async () => {
            if( fail ) throw new Error( `daemon busy` )
            return BUILDX_DU
        }
        const check = () => refresh_cache_health( { run_command, command_prefix: [ `docker` ], now: () => clock, path } )

        await check()
        fail = true
        clock += 61 * 60_000
        expect( ( await check() ).build_cache_bytes ).toBe( 235_400_000_000 )
        expect( read_cache_health( path ).claimed_at ).toBe( clock )

        // Within the claim nobody re-runs the hung or failed check
        clock += 5 * 60_000
        let ran = false
        await refresh_cache_health( { run_command: async () => ( ran = true, BUILDX_DU ), command_prefix: [ `docker` ], now: () => clock, path } )
        expect( ran ).toBe( false )
    } )

    it( `warns only above the threshold`, () => {
        expect( cache_warning( {} ) ).toBeNull()
        expect( cache_warning( { build_cache_bytes: BUILD_CACHE_WARN_BYTES } ) ).toBeNull()
        expect( cache_warning( { build_cache_bytes: 235.4e9 } ) ).toContain( `235 GB` )
    } )

} )
