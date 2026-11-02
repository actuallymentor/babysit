import { describe, it, expect } from 'bun:test'
import { randomBytes } from 'crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { directory_bytes, format_bytes, group_by_filesystem } from '../src/disk.js'
import {
    BUILD_CACHE_WARN_BYTES,
    disk_warnings,
    read_disk_health,
    refresh_disk_health,
    under_pressure,
} from '../src/disk_health.js'
import { parse_build_cache, parse_docker_age, parse_docker_size } from '../src/docker/disk_usage.js'

const temp_dir = () => mkdtempSync( join( tmpdir(), `babysit-disk-health-` ) )

// Default `docker buildx du` table; `--filter until=` is ignored by buildx
const BUILDX_DU = [
    `ID                           RECLAIMABLE   SIZE       LAST ACCESSED`,
    `wmncze0wuhidb3fdtn35e32az    true          7.829GB    13 days ago`,
    `zrpxwcwzbmhk5qfixfivlwhjb    true          7.83GB*    2 weeks ago`,
    `p1npzu0phxy7mq5zqau7je0jf    true          11.78GB    4 days ago`,
    `q1npzu0phxy7mq5zqau7je0jf    false         50GB       30 days ago`,
    `r1npzu0phxy7mq5zqau7je0jf    true          1GB        About an hour ago`,
    `Shared:		67.12GB`,
    `Private:	53.5GB`,
    `Reclaimable:	120.6GB`,
    `Total:		120.6GB`,
].join( `\n` )

// One 1 TB filesystem with the given free space
const disk = free_bytes => ( {
    stat: () => ( { dev: 1 } ),
    statfs: () => ( { bsize: 1_000, blocks: 1e9, bavail: free_bytes / 1_000, type: 0 } ),
} )

describe( `disk usage parsing`, () => {

    it( `reads Docker sizes and ages`, () => {
        expect( parse_docker_size( `146.1GB` ) ).toBe( 146_100_000_000 )
        expect( parse_docker_size( `1.2kB` ) ).toBe( 1_200 )
        expect( parse_docker_size( `0B` ) ).toBe( 0 )
        expect( parse_docker_size( `lots` ) ).toBeNull()
        expect( parse_docker_age( `13 days ago` ) ).toBe( 13 * 86_400_000 )
        expect( parse_docker_age( `About an hour ago` ) ).toBe( 3_600_000 )
        expect( parse_docker_age( `2 weeks ago` ) ).toBe( 14 * 86_400_000 )
        expect( parse_docker_age( `soon` ) ).toBeNull()
    } )

    it( `sums reclaimable build cache unused for seven days`, () => {
        expect( parse_build_cache( BUILDX_DU ) ).toEqual( { total_bytes: 120_600_000_000, prunable_bytes: 15_659_000_000, private_prunable_bytes: 7_829_000_000 } )
        expect( parse_build_cache( `` ) ).toEqual( { total_bytes: null, prunable_bytes: 0, private_prunable_bytes: 0 } )
    } )

    it( `formats decimal sizes`, () => {
        expect( format_bytes( 0 ) ).toBe( `0 B` )
        expect( format_bytes( 2_048 ) ).toBe( `2.0 kB` )
        expect( format_bytes( 38.4e9 ) ).toBe( `38 GB` )
        expect( format_bytes( null ) ).toBe( `unknown` )
    } )

    it( `measures directories with du and groups parts by filesystem`, async () => {
        const directory = temp_dir()
        mkdirSync( join( directory, `nested` ) )
        writeFileSync( join( directory, `nested`, `file` ), randomBytes( 64 * 1_024 ) )
        // ZFS allocates blocks at the next txg sync, so fresh writes can read small
        expect( await directory_bytes( directory ) ).toBeGreaterThan( 0 )
        expect( await directory_bytes( join( directory, `missing` ) ) ).toBe( 0 )

        const groups = group_by_filesystem( [
            { path: directory, label: `a` },
            { path: join( directory, `nested` ), label: `b` },
            { path: `/no/such/path`, label: `c` },
        ] )
        expect( groups.length ).toBe( 1 )
        expect( groups[0].parts.map( ( { label } ) => label ) ).toEqual( [ `a`, `b` ] )
    } )

} )

describe( `disk health`, () => {

    it( `measures at most hourly, one process at a time, keeping last values on failure`, async () => {
        const path = join( temp_dir(), `disk-health.json` )
        let clock = 0
        let calls = 0
        let fail = false
        const check = () => refresh_disk_health( {
            measure_cache: async () => {
                calls++
                if( fail ) throw new Error( `daemon busy` )
                return { total_bytes: 120e9, prunable_bytes: 20e9 }
            },
            find_root_dir: async () => `/var/lib/docker`,
            measure_directory: async () => 40e9,
            clones_dir: `/clones`,
            now: () => clock,
            path,
        } )

        expect( await check() ).toEqual( {
            checked_at: 0, clones_dir: `/clones`, clones_bytes: 40e9,
            docker_root_dir: `/var/lib/docker`, build_cache_bytes: 120e9,
        } )

        clock += 30 * 60_000
        await check()
        expect( calls ).toBe( 1 )

        fail = true
        clock += 31 * 60_000
        expect( ( await check() ).build_cache_bytes ).toBe( 120e9 )
        expect( calls ).toBe( 2 )
        expect( read_disk_health( path ).checked_at ).toBe( clock )
    } )

    it( `needs low space AND a heavy share, or a nearly full disk`, () => {
        const total_bytes = 1e12
        // Big drive, big-but-proportionate usage: quiet
        expect( under_pressure( { total_bytes, free_bytes: 400e9, babysit_bytes: 400e9 } ) ).toBe( false )
        // Low space, but someone else filled it
        expect( under_pressure( { total_bytes, free_bytes: 100e9, babysit_bytes: 50e9 } ) ).toBe( false )
        expect( under_pressure( { total_bytes, free_bytes: 100e9, babysit_bytes: 300e9 } ) ).toBe( true )
        // Nearly full warns whoever filled it, but not a small disk that is mostly free
        expect( under_pressure( { total_bytes, free_bytes: 5e9, babysit_bytes: 0 } ) ).toBe( true )
        expect( under_pressure( { total_bytes: 16e9, free_bytes: 9e9, babysit_bytes: 0 } ) ).toBe( false )
        // Hysteresis: once warned, 17% free is still not enough to clear
        expect( under_pressure( { total_bytes, free_bytes: 170e9, babysit_bytes: 300e9 } ) ).toBe( false )
        expect( under_pressure( { total_bytes, free_bytes: 170e9, babysit_bytes: 300e9 }, true ) ).toBe( true )
        expect( under_pressure( { total_bytes, free_bytes: 210e9, babysit_bytes: 300e9 }, true ) ).toBe( false )
    } )

    it( `names the disk and where Babysit's share lives`, () => {
        const health = { clones_dir: `/clones`, clones_bytes: 250e9, docker_root_dir: `/docker`, build_cache_bytes: 60e9 }

        const pressured = disk_warnings( health, { seams: disk( 90e9 ) } )
        expect( pressured.lines ).toEqual( [
            `Disk holding /clones is 91% full (90 GB free); Babysit stores clones 250 GB, Docker build cache 60 GB. Run \`babysit prune\` to see what can go.`,
        ] )
        expect( [ ...pressured.pressured ] ).toEqual( [ 1 ] )

        expect( disk_warnings( health, { seams: disk( 170e9 ) } ).lines ).toEqual( [] )
        expect( disk_warnings( health, { seams: disk( 170e9 ), pressured: new Set( [ 1 ] ) } ).lines.length ).toBe( 1 )
    } )

    it( `warns about a nearly full disk even before Babysit's share is measured`, () => {
        const { lines } = disk_warnings( { clones_dir: `/clones` }, { seams: disk( 5e9 ) } )
        expect( lines ).toEqual( [
            `Disk holding /clones is 100% full (5.0 GB free); Babysit's share is not measured yet. Run \`babysit prune\` to see what can go.`,
        ] )
    } )

    it( `still flags a launch-stalling build cache on a roomy disk`, () => {
        expect( disk_warnings( { build_cache_bytes: BUILD_CACHE_WARN_BYTES } ).lines ).toEqual( [] )
        expect( disk_warnings( { build_cache_bytes: 235e9 } ).lines[0] ).toContain( `Docker build cache is 235 GB` )
    } )

} )
