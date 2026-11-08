// `babysit mac`: remote Macs over SSH (key) and Screen Sharing (VNC). The
// registry and secrets sit in ~/.config/babysit-mac, uploaded at launch only
// for --mac / --devices sessions. Self-contained: this directory ships into
// the image bare, so it cannot reach src/. Secrets are read from files and
// piped over stdin; they never appear in argv, output or logs.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'

export const ROOT = process.env.BABYSIT_MAC_ROOT || `${ homedir() }/.config/babysit-mac`
const VNC = process.env.BABYSIT_MAC_VNC || `/opt/mac/vnc.py`

export const mac_help = `Usage: babysit mac list | ssh | sudo | scp | run | shot | click | move | drag | type | key | scroll | unlock
Remote Macs (--mac / --devices sessions). Register on the host: babysit mac add.

  babysit mac list                              Macs and whether SSH (22) / Screen Sharing (5900) answer
  babysit mac ssh NAME [cmd...]                 run a command (login shell), or open a shell
  babysit mac sudo NAME cmd...                  sudo with the stored password (never typed by you)
  babysit mac scp NAME SRC DST                  copy files; remote paths start with mac: (mac:/tmp/a.png)
  babysit mac run NAME 'click 10 20; type hi; key Return; shot'   several GUI actions on ONE connection (or script on stdin)
  babysit mac shot NAME [out.png] [--full]      screenshot, long edge <= 1568 px; coordinates below are pixels of the last shot
  babysit mac click NAME X Y [right|double]     babysit mac move NAME X Y      babysit mac drag NAME X1 Y1 X2 Y2
  babysit mac type NAME text...                 babysit mac key NAME Cmd+space Return   (one chord per arg)
  babysit mac scroll NAME up|down [N]           babysit mac unlock NAME        type the password and click the lock screen's arrow

Each GUI call logs in again and typing waits ~2.5 s, so chain steps with run. Prefer ssh
(osascript, screencapture -x, open, defaults); use the GUI when ssh cannot.`

const GUI = [ `run`, `shot`, `click`, `move`, `drag`, `type`, `key`, `scroll`, `unlock` ]

// ---------------------------------------------------------------------------
// Registry

export const load_macs = async root => {
    try {
        return JSON.parse( await readFile( `${ root }/macs.json`, `utf8` ) ).macs ?? []
    } catch {
        return []
    }
}

const find_mac = async ( root, name ) => {
    const macs = await load_macs( root )
    const mac = macs.find( entry => [ entry.name, entry.host ].includes( name ) )
    if( !mac ) throw new Error( macs.length
        ? `Unknown Mac ${ name }; registered: ${ macs.map( entry => entry.name ).join( `, ` ) }`
        : no_macs_message() )
    return mac
}

// Without credentials the session either never asked for --mac, or its memory-only
// copy is gone (the container restarted, or the Mac was disabled or forgotten)
const no_macs_message = () => process.env.BABYSIT_MAC === `1`
    ? `This session asked for --mac but holds no Mac credentials: the container restarted, or the Mac was disabled/forgotten on the host (babysit mac list). Relaunch the session.`
    : `No Macs in this session: start it with --mac or --devices (after babysit mac add on the host)`

// Options shared by ssh and scp. accept-new pins the host key on first contact.
const ssh_options = ( root, mac ) => [
    `-i`, `${ root }/${ mac.name }/id_ed25519`,
    `-o`, `IdentitiesOnly=yes`,
    `-o`, `UserKnownHostsFile=${ root }/${ mac.name }/known_hosts`,
    `-o`, `StrictHostKeyChecking=accept-new`,
    `-o`, `BatchMode=yes`,
    `-o`, `ConnectTimeout=10`,
]

// ---------------------------------------------------------------------------
// Default IO, injectable for tests

export const default_run = ( command, args, { input = null } = {} ) => new Promise( resolve => {
    const child = spawn( command, args, { stdio: [ input === null ? `inherit` : `pipe`, `inherit`, `inherit` ] } )
    if( input !== null ) child.stdin.end( input )
    child.on( `error`, error => {
        console.error( `babysit: ${ command }: ${ error.message }` )
        resolve( 127 )
    } )
    child.on( `close`, code => resolve( code ?? 1 ) )
} )

export const default_reachable = ( host, port ) => new Promise( resolve => {
    const socket = connect( { host, port, timeout: 2_000 } )
    socket.on( `connect`, () => resolve( true ) ).on( `timeout`, () => resolve( false ) ).on( `error`, () => resolve( false ) )
    socket.on( `close`, () => socket.destroy() )
    socket.on( `connect`, () => socket.end() )
} )

// ---------------------------------------------------------------------------
// Commands

const list = async io => {

    const macs = await load_macs( io.root )
    if( !macs.length ) {
        io.say( no_macs_message() )
        return 0
    }

    for( const mac of macs ) {
        const [ ssh, vnc ] = await Promise.all( [ io.reachable( mac.host, 22 ), io.reachable( mac.host, 5900 ) ] )
        io.say( `${ mac.name }  ${ mac.user }@${ mac.host }  ssh:${ ssh ? `up` : `down` }  vnc:${ vnc ? `up` : `down` }` )
    }
    return 0

}

/**
 * Run a `babysit mac` command.
 * @param {string[]} args - Arguments after `mac`
 * @param {Object} [io] - Seams: root, run, reachable, say
 * @returns {Promise<number>} Exit code
 */
export const run_mac = async ( args, io = {} ) => {

    io = { root: ROOT, run: default_run, reachable: default_reachable, say: console.log, ...io }
    const [ action, name, ...rest ] = args

    if( !action || [ `help`, `--help`, `-h` ].includes( action ) ) return io.say( mac_help ), 0
    if( action === `list` ) return list( io )
    if( ![ `ssh`, `sudo`, `scp`, ...GUI ].includes( action ) ) throw new Error( `Unknown mac command ${ action }\n${ mac_help }` )
    if( !name ) throw new Error( `Usage: babysit mac ${ action } NAME ...` )

    const mac = await find_mac( io.root, name )
    const target = `${ mac.user }@${ mac.host }`

    if( action === `ssh` ) return io.run( `ssh`, [ ...ssh_options( io.root, mac ), target, ...rest ] )

    if( action === `sudo` ) {
        if( !rest.length ) throw new Error( `Usage: babysit mac sudo NAME cmd...` )
        const password = ( await readFile( `${ io.root }/${ mac.name }/password`, `utf8` ) ).replace( /\n$/, `` )
        // -S reads the password from stdin; -p '' keeps the prompt out of the output
        return io.run( `ssh`, [ ...ssh_options( io.root, mac ), target, `sudo`, `-S`, `-p`, `''`, ...rest ], { input: `${ password }\n` } )
    }

    if( action === `scp` ) {
        if( rest.length < 2 ) throw new Error( `Usage: babysit mac scp NAME SRC DST (remote paths start with mac:)` )
        const remote = path => path.startsWith( `mac:` ) ? `${ target }:${ path.slice( 4 ) }` : path
        return io.run( `scp`, [ `-r`, ...ssh_options( io.root, mac ), ...rest.map( remote ) ] )
    }

    return io.run( `python3`, [ VNC, mac.name, action, ...rest ] )

}
