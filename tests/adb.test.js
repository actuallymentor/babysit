import { describe, it, expect } from 'bun:test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run_adb, load_devices, save_device } from '../src/docker/assets/adb/command.mjs'

const HOST = `10.0.0.2`

// A phone on the LAN: Wireless debugging on a dynamic TLS port, and port 5555
// open only after `adb tcpip` (until "reboot"). `adb tcpip` moves the TLS port.
const fake_phone = ( { tls_port = 39_051, fixed = false, reachable = true } = {} ) => {

    const phone = { tls_port, fixed, calls: [] }
    const serial_open = serial => {
        const [ host, port ] = serial.split( `:` )
        return reachable && host === HOST && ( Number( port ) === phone.tls_port || Number( port ) === 5555 && phone.fixed )
    }

    phone.adb = async args => {
        phone.calls.push( args.join( ` ` ) )
        const [ command, serial, sub ] = args
        if( command === `connect` ) return serial_open( serial ) ? `connected to ${ serial }` : `failed to connect to '${ serial }': Connection refused`
        if( command === `pair` ) return `Successfully paired to ${ serial } [guid=adb-test]`
        if( command === `disconnect` ) return `disconnected ${ serial }`
        if( command === `devices` ) return `List of devices attached\n${ phone.fixed ? `${ HOST }:5555\tdevice` : `` }`
        if( sub === `shell` ) return args.includes( `echo` ) ? `ready` : `CPH2465`
        if( sub === `tcpip` ) {
            phone.fixed = true
            phone.tls_port = 41_234
            return `restarting in TCP mode port: 5555`
        }
        return ``
    }
    phone.scan = async () => reachable ? [ 22, phone.tls_port ] : []
    phone.scanned = () => phone.calls.some( call => call.startsWith( `connect ${ HOST }:22` ) )

    return phone

}

const setup = phone_options => {
    const registry = join( mkdtempSync( join( tmpdir(), `babysit-adb-` ) ), `devices.json` )
    const phone = fake_phone( phone_options )
    const lines = []
    const run = args => run_adb( args, {
        adb: phone.adb,
        scan: phone.scan,
        sleep: async () => {},
        registry,
        now: () => `2026-10-11T12:00:00.000Z`,
        output: { write: text => lines.push( text.trim() ) },
    } )
    return { registry, phone, lines, run }
}

describe( `babysit adb`, () => {

    it( `pairs, finds the connect port by scan, pins 5555 and records the device`, async () => {

        const { registry, phone, lines, run } = setup()
        expect( await run( [ `pair`, `${ HOST }:38775`, `758418`, `--name`, `dev-phone` ] ) ).toBe( 0 )

        expect( phone.calls ).toContain( `pair ${ HOST }:38775 758418` )
        expect( phone.calls ).toContain( `-s ${ HOST }:39051 tcpip 5555` )
        expect( phone.calls ).toContain( `disconnect ${ HOST }:39051` )
        expect( await load_devices( registry ) ).toEqual( [ {
            host: HOST, port: 39_051, tcpip: true, name: `dev-phone`, model: `CPH2465`, last_seen: `2026-10-11T12:00:00.000Z`,
        } ] )
        expect( lines.at( -1 ) ).toContain( `connected as ${ HOST }:5555` )

    } )

    it( `reconnects on the fixed port without scanning`, async () => {

        const { registry, phone, run } = setup( { fixed: true } )
        await save_device( { host: HOST, port: 39_051, name: `dev-phone` }, registry )

        expect( await run( [] ) ).toBe( 0 )
        expect( phone.scanned() ).toBe( false )
        expect( phone.calls.filter( call => call.includes( `tcpip` ) ) ).toEqual( [] )

    } )

    it( `scans for the new port after a reboot and pins 5555 again`, async () => {

        const { registry, phone, run } = setup( { tls_port: 44_444 } )
        await save_device( { host: HOST, port: 39_051, name: `dev-phone` }, registry )

        expect( await run( [ `up`, `--quiet` ] ) ).toBe( 0 )
        expect( phone.calls ).toContain( `connect ${ HOST }:39051` )
        expect( phone.calls ).toContain( `-s ${ HOST }:44444 tcpip 5555` )
        expect( ( await load_devices( registry ) )[0].port ).toBe( 44_444 )

    } )

    it( `keeps the Wireless debugging connection when tcpip is off`, async () => {

        const { registry, phone, lines, run } = setup()
        expect( await run( [ `add`, `${ HOST }:39051`, `--no-tcpip` ] ) ).toBe( 0 )

        expect( phone.calls.filter( call => call.includes( `tcpip` ) ) ).toEqual( [] )
        expect( ( await load_devices( registry ) )[0] ).toMatchObject( { tcpip: false, name: `CPH2465` } )
        expect( lines.at( -1 ) ).toContain( `connected as ${ HOST }:39051` )

    } )

    it( `reports unreachable devices and fails without dropping them`, async () => {

        const { registry, lines, run } = setup( { reachable: false } )
        await save_device( { host: HOST, port: 39_051, name: `dev-phone` }, registry )

        expect( await run( [ `up`, `--quiet` ] ) ).toBe( 1 )
        expect( lines ).toEqual( [ `dev-phone: unreachable (${ HOST }). Is Wireless debugging on?` ] )
        expect( await load_devices( registry ) ).toHaveLength( 1 )

    } )

    it( `merges devices into a registry every uid can rewrite`, async () => {

        const { registry, run } = setup()
        await save_device( { host: `10.0.0.9`, name: `other` }, registry )
        await save_device( { host: HOST, name: `dev-phone` }, registry )
        await save_device( { host: HOST, name: `renamed` }, registry )

        expect( ( await load_devices( registry ) ).map( ( { name } ) => name ) ).toEqual( [ `other`, `renamed` ] )
        expect( statSync( registry ).mode & 0o777 ).toBe( 0o666 )

        expect( await run( [ `forget`, HOST ] ) ).toBe( 0 )
        expect( ( await load_devices( registry ) ).map( ( { host } ) => host ) ).toEqual( [ `10.0.0.9` ] )

    } )

    it( `is quiet with an empty registry and rejects unknown subcommands`, async () => {

        const { lines, run } = setup()
        expect( await run( [ `up`, `--quiet` ] ) ).toBe( 0 )
        expect( lines ).toEqual( [] )
        expect( run( [ `bogus` ] ) ).rejects.toThrow( `Usage: babysit adb` )

    } )

} )
