// `babysit ios`: a device registry on the shared babysit-ios volume so every
// --ios session can drive recorded iPhones. Self-contained: this directory
// ships into the image bare, so it cannot reach src/.
//
// Reach is plain LAN: lockdown on :62078 (pair record from the volume) starts
// the installed WebDriverAgent runner, which serves HTTP on :8100. iOS 16 and
// older only (newer iOS needs a root tunnel). `up` leaves a detached supervisor
// per device that relaunches the runner whenever it goes down.

import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { readFile, writeFile, rename, copyFile, unlink, mkdir, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export const ROOT = process.env.BABYSIT_IOS_ROOT || `/opt/babysit-ios`
export const WDA_PORT = 8100
export const DEFAULT_RUNNER = `com.facebook.WebDriverAgentRunner.xctrunner`

export const ios_help = `Usage: babysit ios [up|list|add|forget]
Shared iPhone registry for --ios sessions (/opt/babysit-ios). iOS 16 and older,
over the LAN. Needs a WebDriverAgent runner installed on the phone (built once
with Xcode) and the Mac's pair record (/var/db/lockdown/UDID.plist).

  babysit ios [up] [--quiet]                       start WebDriverAgent supervisors (relaunch when down)
  babysit ios list                                 recorded devices and WebDriverAgent state
  babysit ios add HOST UDID PAIR.plist [--name N] [--runner BUNDLE_ID]
                                                   record a device and its pair record
  babysit ios forget NAME|HOST|UDID                drop a device and its pair record

Drive a ready device (set the idle settings or source() fails on iOS 16):
  import wda; c = wda.Client('http://HOST:8100'); s = c.session()
  c.http.post(f'session/{s.session_id}/appium/settings', {'settings': {'waitForIdleTimeout': 0, 'animationCoolOffTimeout': 0}})`

// ---------------------------------------------------------------------------
// Registry: plain JSON every session uid can rewrite, saved read-merge-write

const registry_path = root => `${ root }/devices.json`

export const load_devices = async root => {
    try {
        return JSON.parse( await readFile( registry_path( root ), `utf8` ) ).devices ?? []
    } catch {
        return []
    }
}

const save_devices = async ( root, devices ) => {
    const tmp = `${ registry_path( root ) }.${ randomUUID() }.tmp`
    await writeFile( tmp, JSON.stringify( { devices }, null, 2 ) )
    await chmod( tmp, 0o666 )
    await rename( tmp, registry_path( root ) )
}

const matches = ( device, target ) => [ device.name, device.host, device.udid ].includes( target )

// ---------------------------------------------------------------------------
// Default IO, injectable for tests

export const default_status = async host => {
    try {
        const response = await fetch( `http://${ host }:${ WDA_PORT }/status`, { signal: AbortSignal.timeout( 3_000 ) } )
        return ( await response.json() ).value?.ready === true
    } catch {
        return false
    }
}

// The supervisor relaunches the runner whenever it dies and exits at once when this
// container already has one (flock), so calling it again is always safe
const default_launch = ( { host, udid, runner } ) => {
    const log = openSync( `/tmp/babysit-ios-wda.log`, `a` )
    spawn( `python3`, [ `/opt/ios/wda.py`, host, udid, runner ], { detached: true, stdio: [ `ignore`, log, log ] } ).unref()
}

const default_sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) )

// Mirror pair records where pymobiledevice3's own CLI looks for them
const publish_records = async ( root, home ) => {
    await mkdir( home, { recursive: true } )
    for( const { udid } of await load_devices( root ) ) await copyFile( `${ root }/records/${ udid }.plist`, `${ home }/${ udid }.plist` ).catch( () => {} )
}

// ---------------------------------------------------------------------------
// Commands

const up = async ( { quiet }, io ) => {

    const devices = await load_devices( io.root )
    if( !devices.length ) {
        if( !quiet ) io.say( `No iOS devices recorded. Add one with: babysit ios add HOST UDID PAIR.plist` )
        return 0
    }

    await publish_records( io.root, io.home )

    let failed = 0
    for( const device of devices ) {
        if( await io.status( device.host ) ) {
            io.say( `${ device.name }: ready (${ device.host })` )
            continue
        }
        io.launch( device )

        // The runner needs a few seconds after launch to open :8100
        let ready = false
        for( let waited = 0; waited < 30_000 && !ready; waited += 2_000 ) {
            await io.sleep( 2_000 )
            ready = await io.status( device.host )
        }
        io.say( `${ device.name }: ${ ready ? `ready` : `not ready` } (${ device.host })` )
        if( !ready ) failed++
    }
    return failed ? 1 : 0

}

const list = async io => {
    const devices = await load_devices( io.root )
    if( !devices.length ) return io.say( `No iOS devices recorded.` ), 0
    for( const device of devices ) io.say( `${ device.name }  ${ device.host }  ${ device.udid }  ${ await io.status( device.host ) ? `ready` : `down` }` )
    return 0
}

const add = async ( args, io ) => {

    const take = flag => {
        const at = args.indexOf( flag )
        return at < 0 ? undefined : args.splice( at, 2 )[ 1 ]
    }
    const name = take( `--name` )
    const runner = take( `--runner` ) ?? DEFAULT_RUNNER
    const [ host, udid, plist ] = args
    if( !host || !udid || !plist ) throw new Error( `Usage: babysit ios add HOST UDID PAIR.plist [--name N] [--runner BUNDLE_ID]` )

    // A 0644 copy in a root-owned volume dir: sessions run as different uids
    await mkdir( `${ io.root }/records`, { recursive: true } )
    await copyFile( plist, `${ io.root }/records/${ udid }.plist` )
    await chmod( `${ io.root }/records/${ udid }.plist`, 0o644 )

    const devices = ( await load_devices( io.root ) ).filter( device => device.udid !== udid )
    devices.push( { name: name ?? host, host, udid, runner, added: io.now() } )
    await save_devices( io.root, devices )
    io.say( `Recorded ${ name ?? host } (${ host }). Launch it with: babysit ios up` )
    return 0

}

const forget = async ( [ target ], io ) => {
    if( !target ) throw new Error( `Usage: babysit ios forget NAME|HOST|UDID` )
    const devices = await load_devices( io.root )
    const gone = devices.filter( device => matches( device, target ) )
    await save_devices( io.root, devices.filter( device => !matches( device, target ) ) )
    for( const { udid } of gone ) await unlink( `${ io.root }/records/${ udid }.plist` ).catch( () => {} )
    io.say( gone.length ? `Forgot ${ gone.map( device => device.name ).join( `, ` ) }` : `${ target } was not recorded` )
    return 0
}

export const run_ios = async ( args = [], {
    root = ROOT,
    status = default_status,
    launch = default_launch,
    sleep = default_sleep,
    home = `${ homedir() }/.pymobiledevice3`,
    output = process.stdout,
    now = () => new Date().toISOString(),
} = {} ) => {

    const io = { root, status, launch, sleep, home, now, say: line => output.write( `${ line }\n` ) }
    const [ command = `up`, ...rest ] = args

    if( [ `--help`, `-h`, `help` ].includes( command ) ) return io.say( ios_help ), 0
    if( command === `up` || command === `--quiet` ) return up( { quiet: args.includes( `--quiet` ) }, io )
    if( command === `list` ) return list( io )
    if( command === `add` ) return add( rest, io )
    if( command === `forget` ) return forget( rest, io )
    throw new Error( ios_help )

}
