import { describe, it, expect } from 'bun:test'
import { container_stats, parse_container_stats, stats_for_session } from '../src/docker/stats.js'

const FULL_ID = `9d429cf6a1e0f5a442696abc80a69efac0815c706131dadbd4b4c8c64013ae7d`

describe( `container stats`, () => {

    it( `parses docker stats rows and keeps only used memory`, () => {

        const rows = parse_container_stats( [
            `${ FULL_ID }\tbabysit-one\t24.38%\t242.1MiB / 30.92GiB`,
            `${ `b`.repeat( 64 ) }\tbabysit-two\t0.00%\t0B / 0B`,
            ``,
        ].join( `\n` ) )

        expect( rows ).toEqual( [
            { id: FULL_ID, name: `babysit-one`, cpu: `24.38%`, memory: `242.1MiB` },
            { id: `b`.repeat( 64 ), name: `babysit-two`, cpu: `0.00%`, memory: `0B` },
        ] )

    } )

    it( `samples every running container once, untruncated, through the docker prefix`, async () => {

        const calls = []
        const rows = await container_stats( {
            command_prefix: [ `sudo`, `docker` ],
            run_command: async ( command, args ) => {
                calls.push( [ command, ...args ] )
                return `${ FULL_ID }\tbabysit-one\t1.00%\t10MiB / 1GiB\n`
            },
        } )

        expect( calls ).toEqual( [ [ `sudo`, `docker`, `stats`, `--no-stream`, `--no-trunc`, `--format`, `{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}` ] ] )
        expect( rows ).toHaveLength( 1 )

    } )

    it( `degrades to no samples when docker fails`, async () => {
        const rows = await container_stats( { run_command: async () => Promise.reject( new Error( `no daemon` ) ) } )
        expect( rows ).toEqual( [] )
    } )

    it( `matches a session by truncated id, full id, or container name`, () => {

        const stats = [ { id: FULL_ID, name: `babysit-baby-1`, cpu: `1%`, memory: `1MiB` } ]

        expect( stats_for_session( stats, { container_id: FULL_ID.slice( 0, 12 ) } )?.cpu ).toBe( `1%` )
        expect( stats_for_session( stats, { container_id: FULL_ID } )?.cpu ).toBe( `1%` )
        expect( stats_for_session( stats, { container_name: `babysit-baby-1` } )?.cpu ).toBe( `1%` )
        expect( stats_for_session( stats, { babysit_id: `baby-1` } )?.cpu ).toBe( `1%` )
        expect( stats_for_session( stats, undefined ) ).toBeNull()
        expect( stats_for_session( stats, { container_id: `ffff`, container_name: `other` } ) ).toBeNull()
        expect( stats_for_session( stats, {} ) ).toBeNull()

    } )

} )
