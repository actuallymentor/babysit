import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run_ios, load_devices } from '../src/docker/assets/ios/command.mjs'

// Fake UDID, and every run gets its own home: `up` writes pair records there
const UDID = `00000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`

// A volume root plus a pair record to import, with a fake phone whose WebDriverAgent
// only comes up after a launch
const setup = () => {

    const root = mkdtempSync( join( tmpdir(), `babysit-ios-` ) )
    const plist = join( root, `source.plist` )
    writeFileSync( plist, `pair-record` )

    const home = join( root, `home` )
    const phone = { ready: false, launched: [] }
    const lines = []
    const run = ( args, extra = {} ) => run_ios( args, {
        root,
        home,
        status: async () => phone.ready,
        launch: device => { phone.launched.push( device.udid ); phone.ready = true },
        sleep: async () => {},
        output: { write: line => lines.push( line.trim() ) },
        now: () => `2026-10-21T00:00:00.000Z`,
        ...extra,
    } )

    return { root, home, plist, phone, lines, run }

}

describe( `babysit ios`, () => {

    it( `add records the device and a pair record`, async () => {
        const { root, plist, run } = setup()

        expect( await run( [ `add`, `192.168.2.75`, UDID, plist, `--name`, `iphone` ] ) ).toBe( 0 )

        const [ device ] = await load_devices( root )
        expect( device ).toMatchObject( { name: `iphone`, host: `192.168.2.75`, udid: UDID, runner: `com.facebook.WebDriverAgentRunner.xctrunner` } )
        expect( readFileSync( join( root, `records`, `${ UDID }.plist` ), `utf8` ) ).toBe( `pair-record` )
    } )

    it( `add takes a custom runner bundle id`, async () => {
        const { root, plist, run } = setup()
        await run( [ `add`, `10.0.0.9`, UDID, plist, `--runner`, `com.palokaj.WebDriverAgentRunner.xctrunner` ] )
        expect( ( await load_devices( root ) )[ 0 ].runner ).toBe( `com.palokaj.WebDriverAgentRunner.xctrunner` )
    } )

    it( `up launches WebDriverAgent only when it is not already ready`, async () => {
        const { home, plist, phone, lines, run } = setup()
        await run( [ `add`, `192.168.2.75`, UDID, plist, `--name`, `iphone` ] )

        expect( await run( [ `up` ] ) ).toBe( 0 )
        expect( readFileSync( join( home, `${ UDID }.plist` ), `utf8` ) ).toBe( `pair-record` )
        expect( phone.launched ).toEqual( [ UDID ] )
        expect( lines.at( -1 ) ).toBe( `iphone: ready (192.168.2.75)` )

        // A second session finds it running and leaves it alone
        await run( [ `up`, `--quiet` ] )
        expect( phone.launched ).toEqual( [ UDID ] )
    } )

    it( `up fails when the device never becomes ready`, async () => {
        const { plist, lines, run } = setup()
        await run( [ `add`, `192.168.2.75`, UDID, plist ] )

        expect( await run( [ `up` ], { launch: () => {} } ) ).toBe( 1 )
        expect( lines.at( -1 ) ).toContain( `not ready` )
    } )

    it( `up is silent and succeeds with no devices when quiet`, async () => {
        const { lines, run } = setup()
        expect( await run( [ `up`, `--quiet` ] ) ).toBe( 0 )
        expect( lines ).toEqual( [] )
    } )

    it( `list shows state, forget drops device and pair record`, async () => {
        const { root, plist, phone, lines, run } = setup()
        await run( [ `add`, `192.168.2.75`, UDID, plist, `--name`, `iphone` ] )

        await run( [ `list` ] )
        expect( lines.at( -1 ) ).toBe( `iphone  192.168.2.75  ${ UDID }  down` )
        phone.ready = true
        await run( [ `list` ] )
        expect( lines.at( -1 ) ).toContain( `ready` )

        await run( [ `forget`, `iphone` ] )
        expect( await load_devices( root ) ).toEqual( [] )
        expect( existsSync( join( root, `records`, `${ UDID }.plist` ) ) ).toBe( false )
    } )

    it( `add without a pair record explains the usage`, async () => {
        const { run } = setup()
        await expect( run( [ `add`, `192.168.2.75` ] ) ).rejects.toThrow( `Usage: babysit ios add` )
    } )

} )
