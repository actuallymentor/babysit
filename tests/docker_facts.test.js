import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cached_docker_id, docker_endpoint_key, forget_image_facts, image_facts } from '../src/docker/facts.js'
import { within_deadline } from '../src/utils/deadline.js'

const temp_path = () => join( mkdtempSync( join( tmpdir(), `babysit-facts-` ) ), `docker-facts.json` )
const never = () => new Promise( () => {} )

describe( `within_deadline`, () => {

    it( `prefers the answer, else the fallback`, async () => {

        expect( await within_deadline( Promise.resolve( `fast` ), 50, () => `late` ) ).toBe( `fast` )
        expect( await within_deadline( never(), 10, () => `late` ) ).toBe( `late` )

    } )

} )

describe( `docker facts`, () => {

    it( `keys the cache on the endpoint Docker would use, in Docker's precedence`, () => {

        expect( docker_endpoint_key( { DOCKER_HOST: `tcp://box:2375`, DOCKER_CONFIG: `/cfg` } ) ).toBe( `host:tcp://box:2375` )
        expect( docker_endpoint_key( { DOCKER_CONTEXT: `remote`, DOCKER_HOST: `tcp://box:2375`, DOCKER_CONFIG: `/cfg` } ) ).toBe( `context:/cfg:remote` )
        expect( docker_endpoint_key( { DOCKER_CONFIG: `/nonexistent` } ) ).toBe( `context:default` )

    } )

    it( `serves an expired daemon ID when docker info stalls or fails`, async () => {

        const path = temp_path()
        let clock = 0
        const base = { command_prefix: [ `docker` ], endpoint: `context:default`, path, remembers: true, now: () => clock }
        await cached_docker_id( { ...base, run_command: async () => `OLD:ID` } )

        clock += 48 * 3_600_000
        expect( await cached_docker_id( { ...base, run_command: never } ) ).toBe( `OLD:ID` )
        expect( await cached_docker_id( { ...base, run_command: async () => {
            throw new Error( `timed out` )
        } } ) ).toBe( `OLD:ID` )

    } )

    it( `asks docker info once, then serves the daemon ID from cache`, async () => {

        const path = temp_path()
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args.join( ` ` ) )
            return `DAEMON:ID\n`
        }

        const options = { run_command, command_prefix: [ `docker` ], endpoint: `context:default`, path, remembers: true }
        expect( await cached_docker_id( options ) ).toBe( `DAEMON:ID` )
        expect( await cached_docker_id( options ) ).toBe( `DAEMON:ID` )
        expect( calls ).toEqual( [ `info --format {{.ID}}` ] )

    } )

    it( `reads image ID and gate from one inspect and remembers them`, async () => {

        const path = temp_path()
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args.slice( 0, 3 ).join( ` ` ) )
            return `sha256:abc 1\n`
        }

        const options = { run_command, image: `babysit:facts-a`, command_prefix: [ `docker` ], path, remembers: true }
        expect( await image_facts( options ) ).toEqual( { id: `sha256:abc`, gate: true } )
        expect( await image_facts( options ) ).toEqual( { id: `sha256:abc`, gate: true } )
        expect( calls ).toEqual( [ `image inspect babysit:facts-a` ] )
        const remembered = Object.entries( JSON.parse( readFileSync( path, `utf8` ) ).images )
        expect( remembered ).toEqual( [ [ expect.stringMatching( / babysit:facts-a$/ ), { id: `sha256:abc`, at: expect.any( Number ) } ] ] )

    } )

    it( `falls back to the remembered ID, never an unverified gate, when the daemon stalls`, async () => {

        const path = temp_path()
        const image = `babysit:facts-b`
        await image_facts( { run_command: async () => `sha256:old 1`, image, command_prefix: [ `docker` ], path, remembers: true } )

        const stalled = await image_facts( { run_command: never, image, command_prefix: [ `docker` ], path, remembers: true, deadline_ms: 10 } )
        expect( stalled ).toEqual( { id: `sha256:old`, gate: false } )

    } )

    it( `waits for the daemon when nothing is remembered, and forgets on request`, async () => {

        const path = temp_path()
        const image = `babysit:facts-c`
        const slow = () => new Promise( resolve => setTimeout( () => resolve( `sha256:new ` ), 30 ) )

        expect( await image_facts( { run_command: slow, image, command_prefix: [ `docker` ], path, remembers: true, deadline_ms: 1 } ) ).toEqual( { id: `sha256:new`, gate: false } )

        forget_image_facts( image, path )
        expect( JSON.parse( readFileSync( path, `utf8` ) ).images ).toEqual( {} )

    } )

    it( `never touches the cache for stub runners by default`, async () => {

        const path = temp_path()
        await image_facts( { run_command: async () => `sha256:stub 1`, image: `babysit:facts-d`, command_prefix: [ `docker` ], path } )
        expect( () => readFileSync( path ) ).toThrow()

    } )

} )
