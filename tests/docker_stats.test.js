import { describe, it, expect } from 'bun:test'
import {
    cached_usage,
    docker_host_capacity,
    format_memory,
    parse_memory,
    parse_usage_row,
    sample_container_usage,
    start_usage_sampler,
} from '../src/docker/stats.js'

describe( `container usage`, () => {

    it( `parses docker memory units into bytes and formats whole units back`, () => {
        expect( parse_memory( `334.8MiB` ) ).toBe( Math.round( 334.8 * 1024 ** 2 ) )
        expect( parse_memory( `1.5GiB` ) ).toBe( 1.5 * 1024 ** 3 )
        expect( parse_memory( `0B` ) ).toBe( 0 )
        expect( parse_memory( `12kB` ) ).toBe( 12_000 )
        expect( parse_memory( `garbage` ) ).toBeNull()
        expect( format_memory( 334.8 * 1024 ** 2 ) ).toBe( `335 MiB` )
        expect( format_memory( 1.5 * 1024 ** 3 ) ).toBe( `1536 MiB` )
        expect( format_memory( 12.4 * 1024 ** 3 ) ).toBe( `12 GiB` )
    } )

    it( `parses a single stats row and rejects unreadable ones`, () => {
        expect( parse_usage_row( `24.38%\t242.1MiB / 30.92GiB\n` ) ).toEqual( { cpu_percent: 24.38, memory_bytes: Math.round( 242.1 * 1024 ** 2 ) } )
        expect( parse_usage_row( `` ) ).toBeNull()
        expect( parse_usage_row( `--\t-- / --` ) ).toBeNull()
    } )

    it( `samples one container through the docker prefix and degrades to null`, async () => {
        const calls = []
        const usage = await sample_container_usage( `abc`, {
            command_prefix: [ `sudo`, `docker` ],
            run_command: async ( command, args ) => {
                calls.push( [ command, ...args ] )
                return `1.00%\t10MiB / 1GiB\n`
            },
        } )
        expect( calls ).toEqual( [ [ `sudo`, `docker`, `stats`, `--no-stream`, `--format`, `{{.CPUPerc}}\t{{.MemUsage}}`, `abc` ] ] )
        expect( usage ).toEqual( { cpu_percent: 1, memory_bytes: 10 * 1024 ** 2 } )
        expect( await sample_container_usage( `gone`, { run_command: async () => Promise.reject( new Error( `no such container` ) ) } ) ).toBeNull()
    } )

    it( `reads host capacity from docker info`, async () => {
        expect( await docker_host_capacity( { run_command: async () => `4 33204768768\n` } ) ).toEqual( { cpus: 4, memory_bytes: 33204768768 } )
        expect( await docker_host_capacity( { run_command: async () => `` } ) ).toBeNull()
    } )

    it( `caches samples with host capacity on the session record`, async () => {
        const updates = []
        const sampler = start_usage_sampler( { babysit_id: `baby`, container_id: `abc` }, {
            interval_ms: 60_000,
            sample: async () => ( { cpu_percent: 5, memory_bytes: 100 } ),
            capacity: async () => ( { cpus: 2, memory_bytes: 1000 } ),
            update: ( ...args ) => updates.push( args ),
            now: () => Date.UTC( 2026, 9, 6 ),
        } )
        await sampler.tick()
        await sampler.stop()
        expect( updates ).toEqual( [ [ `baby`, { usage: {
            cpu_percent: 5, memory_bytes: 100, sampled_at: `2026-10-06T00:00:00.000Z`, host_cpus: 2, host_memory_bytes: 1000,
        } }, { wait_ms: 0 } ] ] )
    } )

    it( `waits for a sample in flight on stop and drops its write`, async () => {
        const updates = []
        let release
        const sampler = start_usage_sampler( { babysit_id: `baby`, container_id: `abc` }, {
            interval_ms: 60_000,
            sample: () => new Promise( resolve => {
                release = () => resolve( { cpu_percent: 1, memory_bytes: 1 } )
            } ),
            capacity: async () => null,
            update: ( ...args ) => updates.push( args ),
        } )
        await Promise.resolve()
        const stopping = sampler.stop()
        release()
        await stopping
        expect( updates ).toEqual( [] )
    } )

    it( `retries a failed capacity read only after ten minutes`, async () => {
        let clock = 0
        let capacity_calls = 0
        const sampler = start_usage_sampler( { babysit_id: `baby`, container_id: `abc` }, {
            interval_ms: 60_000,
            sample: async () => ( { cpu_percent: 1, memory_bytes: 1 } ),
            capacity: async () => {
                capacity_calls++
                return null
            },
            update: () => {},
            now: () => clock,
        } )
        await sampler.tick()
        await sampler.tick()
        clock = 11 * 60_000
        await sampler.tick()
        await sampler.stop()
        expect( capacity_calls ).toBe( 2 )
    } )

    it( `leaves the record untouched when the container is gone`, async () => {
        const updates = []
        const sampler = start_usage_sampler( { babysit_id: `baby`, container_id: `abc` }, {
            interval_ms: 60_000, sample: async () => null, capacity: async () => null, update: ( ...args ) => updates.push( args ),
        } )
        await sampler.tick()
        await sampler.stop()
        expect( updates ).toEqual( [] )
    } )

    it( `ignores stale or malformed cached usage`, () => {
        const now = Date.UTC( 2026, 9, 6, 12 )
        const fresh = { cpu_percent: 1, memory_bytes: 1, sampled_at: new Date( now - 60_000 ).toISOString() }
        const stale = { ...fresh, sampled_at: new Date( now - 10 * 60_000 ).toISOString() }
        expect( cached_usage( { usage: fresh }, now ) ).toEqual( fresh )
        expect( cached_usage( { usage: stale }, now ) ).toBeNull()
        expect( cached_usage( { usage: { cpu_percent: `x` } }, now ) ).toBeNull()
        expect( cached_usage( undefined, now ) ).toBeNull()
    } )

} )
