// `babysit adb`: a device registry on the shared babysit-adb volume so every
// --adb session reconnects to known phones. Self-contained: this directory
// ships into the image bare, so it cannot reach src/.
//
// Reconnect order per device:
//   1. host:5555, the fixed port `adb tcpip` opens until the phone reboots
//   2. the last recorded Wireless debugging port
//   3. a scan of Android's dynamic port range on that host
// After a Wireless debugging connect, `adb tcpip 5555` pins the fixed port so
// later sessions in the same boot skip the scan.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Socket } from 'node:net'
import { readFile, writeFile, rename, chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const exec_file = promisify( execFile )

export const REGISTRY = process.env.BABYSIT_ADB_REGISTRY || `/opt/babysit-adb/devices/devices.json`
export const FIXED_PORT = 5555

// Android's net.ipv4.ip_local_port_range: Wireless debugging binds an ephemeral port
export const DYNAMIC_PORTS = [ 37_000, 50_000 ]

export const adb_help = `Usage: babysit adb [up|list|add|pair|forget]
Shared device registry for --adb sessions (/opt/babysit-adb/devices). Every session
reconnects recorded devices at launch; run \`babysit adb\` to retry by hand.

  babysit adb [up] [--quiet]                       connect every recorded device
  babysit adb list                                 recorded devices and their state
  babysit adb add HOST[:PORT] [--name N] [--no-tcpip]
                                                   connect (scanning if no port) and record
  babysit adb pair HOST:PAIRPORT CODE [--name N] [--no-tcpip]
                                                   pair a new phone, then add it
  babysit adb forget HOST                          drop a device from the registry

--no-tcpip skips pinning port 5555 after a Wireless debugging connect.

Examples:
  babysit adb pair 192.168.2.114:38775 758418 --name oneplus-dev
  babysit adb`

// ---------------------------------------------------------------------------
// Default IO, injectable for tests

const default_adb = async args => {
    try {
        const { stdout, stderr } = await exec_file( `adb`, args, { timeout: 20_000 } )
        return `${ stdout }${ stderr }`.trim()
    } catch ( error ) {
        return `${ error.stdout || `` }${ error.stderr || error.message }`.trim()
    }
}

const probe = ( host, port, timeout_ms ) => new Promise( resolve => {
    const socket = new Socket()
    const done = open => {
        socket.destroy()
        resolve( open )
    }
    socket.setTimeout( timeout_ms )
    socket.once( `connect`, () => done( true ) )
    socket.once( `timeout`, () => done( false ) )
    socket.once( `error`, () => done( false ) )
    socket.connect( port, host )
} )

/** Open TCP ports on host within [from, to], probed in parallel batches. */
export const default_scan = async ( host, [ from, to ] = DYNAMIC_PORTS, { concurrency = 512, timeout_ms = 1_500 } = {} ) => {

    const ports = Array.from( { length: to - from + 1 }, ( _, index ) => from + index )
    const open = []

    // A shared cursor keeps `concurrency` probes in flight without batching stalls
    let cursor = 0
    const worker = async () => {
        while( cursor < ports.length ) {
            const port = ports[ cursor++ ]
            if( await probe( host, port, timeout_ms ) ) open.push( port )
        }
    }
    await Promise.all( Array.from( { length: concurrency }, worker ) )

    return open.sort( ( a, b ) => a - b )

}

const default_sleep = ms => new Promise( resolve => setTimeout( resolve, ms ) )

// ---------------------------------------------------------------------------
// Registry: one JSON file, read-merge-written and atomically renamed so
// sessions of any uid can update it (the entrypoint makes the dir 0777).
// No cross-container lock: two sessions adding different phones in the same
// instant can drop one record. Rare enough not to justify a lock.

export const load_devices = async ( path = REGISTRY ) => {
    try {
        const { devices = [] } = JSON.parse( await readFile( path, `utf8` ) )
        return devices
    } catch {
        return []
    }
}

const write_devices = async ( path, devices ) => {
    // PIDs repeat across containers; a UUID keeps concurrent writers apart
    const temporary = `${ path }.${ randomUUID() }.tmp`
    await writeFile( temporary, `${ JSON.stringify( { devices }, null, 2 ) }\n` )
    // umask would otherwise lock other uids out of the next merge
    await chmod( temporary, 0o666 )
    await rename( temporary, path )
}

export const save_device = async ( device, path = REGISTRY ) => {
    const others = ( await load_devices( path ) ).filter( ( { host } ) => host !== device.host )
    await write_devices( path, [ ...others, device ] )
}

/** Patch the current record, not a stale snapshot; a forgotten device stays gone. */
export const update_device = async ( host, patch, path = REGISTRY ) => {
    const current = ( await load_devices( path ) ).find( device => device.host === host )
    if( current ) await save_device( { ...current, ...patch }, path )
    return Boolean( current )
}

export const forget_device = async ( host, path = REGISTRY ) => {
    const devices = await load_devices( path )
    const remaining = devices.filter( device => device.host !== host )
    await write_devices( path, remaining )
    return devices.length !== remaining.length
}

// ---------------------------------------------------------------------------
// Connecting

const parse_target = target => {
    const [ , host, port ] = String( target ).match( /^([^:\s]+)(?::(\d+))?$/ ) || []
    if( !host ) throw new Error( `Expected HOST or HOST:PORT, got "${ target }"` )
    return { host, port: port ? Number( port ) : null }
}

/**
 * Connect host:port and prove it with a shell round trip: right after
 * `adb tcpip`, get-state can report `device` while the link still flaps.
 */
const connect = async ( adb, host, port ) => {
    if( !port ) return false
    const serial = `${ host }:${ port }`
    const reply = await adb( [ `connect`, serial ] )
    if( !/connected to/.test( reply ) || /failed|unable|cannot/i.test( reply ) ) return false
    const echo = await adb( [ `-s`, serial, `shell`, `echo`, `ready` ] )
    return echo === `ready`
}

/**
 * Restart adbd on the fixed port, then swap the TLS connection for it.
 * Returns the serial that works afterwards, or null when neither does.
 */
const pin_fixed_port = async ( { adb, sleep }, host, port ) => {

    // The reply is unreliable (often empty), so judge by which link survives
    await adb( [ `-s`, `${ host }:${ port }`, `tcpip`, String( FIXED_PORT ) ] )

    // The TLS serial dies with the adbd restart. Drop it first: disconnecting
    // it later makes adb renegotiate the 5555 link, which flaps offline
    await adb( [ `disconnect`, `${ host }:${ port }` ] )

    // Then wait until 5555 answers twice in a row, 1.5 s apart
    let streak = 0
    for( let attempt = 0; attempt < 20 && streak < 2; attempt++ ) {
        await sleep( streak ? 1_500 : 500 )
        streak = await connect( adb, host, FIXED_PORT ) ? streak + 1 : 0
    }
    if( streak === 2 ) return `${ host }:${ FIXED_PORT }`

    // 5555 never came up: if adbd refused to restart, the TLS port still works
    return await connect( adb, host, port ) ? `${ host }:${ port }` : null

}

/**
 * Bring one device online. Returns { serial, port } on success, null otherwise.
 * `port` is the Wireless debugging port when one was found, for the registry.
 */
export const bring_up = async ( device, { adb, scan, sleep } ) => {

    const { host, port: last_port, tcpip = true } = device

    // 1. Fixed port: open until the phone reboots
    if( await connect( adb, host, FIXED_PORT ) ) return { serial: `${ host }:${ FIXED_PORT }`, port: last_port }

    // 2. Last Wireless debugging port, 3. then whatever the scan finds
    const tried = new Set( [ FIXED_PORT ] )
    const attempt = async port => {
        if( tried.has( port ) ) return false
        tried.add( port )
        return connect( adb, host, port )
    }

    let found = await attempt( last_port ) ? last_port : null
    if( !found ) for( const port of await scan( host ) ) {
        if( await attempt( port ) ) {
            found = port
            break
        }
    }
    if( !found ) return null

    if( !tcpip ) return { serial: `${ host }:${ found }`, port: found }

    // Null means adbd restarted, 5555 never settled and the TLS port moved:
    // report it unreachable so the next `babysit adb` rescans
    const serial = await pin_fixed_port( { adb, sleep }, host, found )
    return serial ? { serial, port: found } : null

}

const describe_device = async ( adb, serial ) => {
    const model = await adb( [ `-s`, serial, `shell`, `getprop`, `ro.product.model` ] )
    return /^[\w .-]+$/.test( model ) ? model : null
}

// ---------------------------------------------------------------------------
// Subcommands

const flag_value = ( args, flag ) => {
    const index = args.indexOf( flag )
    return index === -1 ? null : args[ index + 1 ] ?? null
}

const positional = args => args.filter( ( argument, index ) => !argument.startsWith( `--` ) && args[ index - 1 ] !== `--name` )

const up = async ( { quiet }, io ) => {

    const devices = await load_devices( io.registry )
    if( !devices.length ) {
        if( !quiet ) io.say( `No recorded devices. Add one with: babysit adb pair HOST:PAIRPORT CODE` )
        return 0
    }

    // Phones are independent: one offline device must not delay the others
    const results = await Promise.all( devices.map( device => bring_up( device, io ) ) )

    // Save one at a time: parallel read-merge-writes would drop each other's updates
    for( const [ index, device ] of devices.entries() ) {
        const result = results[ index ]
        const label = device.name || device.host
        if( !result ) {
            io.say( `${ label }: unreachable (${ device.host }). Is Wireless debugging on?` )
            continue
        }
        await update_device( device.host, { port: result.port, last_seen: io.now() }, io.registry )
        if( !quiet ) io.say( `${ label }: connected as ${ result.serial }` )
    }

    return results.every( Boolean ) ? 0 : 1

}

const add = async ( args, io ) => {

    const [ target ] = positional( args )
    if( !target ) throw new Error( `Usage: babysit adb add HOST[:PORT] [--name N] [--no-tcpip]` )
    const { host, port } = parse_target( target )
    const known = ( await load_devices( io.registry ) ).find( device => device.host === host ) || {}

    const device = {
        ...known,
        host,
        port: port ?? known.port ?? null,
        tcpip: !args.includes( `--no-tcpip` ) && ( known.tcpip ?? true ),
    }
    const result = await bring_up( device, io )
    if( !result ) throw new Error( `Could not connect to ${ host }. Pair it first (babysit adb pair) and check Wireless debugging is on` )

    const model = await describe_device( io.adb, result.serial ) || known.model || null
    const name = flag_value( args, `--name` ) || known.name || model || host
    await save_device( { ...device, name, model, port: result.port, last_seen: io.now() }, io.registry )
    io.say( `${ name }: connected as ${ result.serial }, recorded in ${ io.registry }` )
    return 0

}

const pair = async ( args, io ) => {

    const [ target, code ] = positional( args )
    if( !target || !code ) throw new Error( `Usage: babysit adb pair HOST:PAIRPORT CODE [--name N] [--no-tcpip]` )
    const { host, port } = parse_target( target )
    if( !port ) throw new Error( `Pairing needs the port shown under "Pair device with pairing code"` )

    const reply = await io.adb( [ `pair`, `${ host }:${ port }`, code ] )
    if( !/Successfully paired/.test( reply ) ) throw new Error( `Pairing failed: ${ reply }` )

    // The pairing port is single-use; the connect port is found by add's scan
    const rest = args.filter( argument => argument !== target && argument !== code )
    return add( [ host, ...rest ], io )

}

const list = async io => {

    const devices = await load_devices( io.registry )
    if( !devices.length ) {
        io.say( `No recorded devices (${ io.registry })` )
        return 0
    }

    const attached = await io.adb( [ `devices` ] )
    for( const { name, host, port, model, tcpip = true, last_seen } of devices ) {
        const online = attached.split( `\n` ).find( line => line.startsWith( `${ host }:` ) && /\tdevice$/.test( line ) )
        const state = online ? `connected ${ online.split( `\t` )[0] }` : `not connected`
        io.say( `${ name || host }  ${ host }  ${ model || `` }  ${ state }  last port ${ port ?? `-` }${ tcpip ? `` : `  (no tcpip)` }  seen ${ last_seen ?? `never` }` )
    }
    return 0

}

/** Entry point for `babysit adb ...`; returns the process exit code. */
export const run_adb = async ( args = [], {
    adb = default_adb,
    scan = default_scan,
    sleep = default_sleep,
    registry = REGISTRY,
    output = process.stdout,
    now = () => new Date().toISOString(),
} = {} ) => {

    const io = { adb, scan, sleep, registry, now, say: line => output.write( `${ line }\n` ) }
    const [ command = `up`, ...rest ] = args

    if( [ `--help`, `-h`, `help` ].includes( command ) ) {
        io.say( adb_help )
        return 0
    }
    if( command === `up` || command === `--quiet` ) return up( { quiet: args.includes( `--quiet` ) }, io )
    if( command === `list` ) return list( io )
    if( command === `add` ) return add( rest, io )
    if( command === `pair` ) return pair( rest, io )
    if( command === `forget` ) {
        const [ target ] = rest
        if( !target ) throw new Error( `Usage: babysit adb forget HOST` )
        const { host } = parse_target( target )
        io.say( await forget_device( host, registry ) ? `Forgot ${ host }` : `${ host } was not recorded` )
        return 0
    }
    throw new Error( adb_help )

}
