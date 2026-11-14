// `babysit mac` / `babysit windows`: remote machines over SSH (key), and the
// screen over VNC (Mac Screen Sharing) or Remote Desktop (Windows).
// The registry and secrets sit in ~/.config/babysit-<kind>, uploaded at launch
// only for --mac / --windows / --devices sessions. Self-contained: this
// directory ships into the image bare, so it cannot reach src/ (the profiles
// below mirror REMOTE_KINDS in src/remote/store.js). Secrets are read from
// files and piped over stdin; they never appear in argv, output or logs.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { homedir } from 'node:os'

const HELPERS = process.env.BABYSIT_REMOTE_HELPERS || `/opt/remote`

const GUI = [ `run`, `shot`, `click`, `move`, `drag`, `type`, `key`, `scroll`, `unlock`, `password` ]

// The screen helper per kind, and the port it talks to
const SCREEN = { mac: { helper: `vnc.py`, port: 5900, label: `vnc` }, windows: { helper: `rdp.py`, port: 3389, label: `rdp` } }

export const mac_help = `Usage: babysit mac list | ssh | sudo | scp | run | shot | click | move | drag | type | key | scroll | unlock | password
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
  babysit mac password NAME                     type the stored password into the focused field (admin/auth dialogs; also a run step)

Each GUI call logs in again and typing waits ~2.5 s, so chain steps with run. Prefer ssh
(osascript, screencapture -x, open, defaults); use the GUI when ssh cannot.`

export const windows_help = `Usage: babysit windows list | ps | ssh | scp | run | shot | click | move | drag | type | key | scroll | unlock | password
Remote Windows PCs (--windows / --devices sessions). Register on the host: babysit windows add.

  babysit windows list                          PCs and whether SSH (22) / Remote Desktop (3389) answer
  babysit windows ps NAME 'script'              run PowerShell (script from the arg, else stdin); admin sessions are elevated
  babysit windows ssh NAME [cmd...]             run a cmd.exe command, or open a shell
  babysit windows scp NAME SRC DST              copy files; remote paths start with win: (win:C:/Users/me/a.png)
  babysit windows run NAME 'click 10 20; type hi; key Return; shot'   several GUI actions on ONE connection (or script on stdin)
  babysit windows shot NAME [out.png] [--full]  screenshot, long edge <= 1568 px; coordinates below are pixels of the last shot
  babysit windows click NAME X Y [right|double] babysit windows move NAME X Y  babysit windows drag NAME X1 Y1 X2 Y2
  babysit windows type NAME text...             babysit windows key NAME Win+r Ctrl+Shift+Esc Return   (one chord per arg)
  babysit windows scroll NAME up|down [N]       babysit windows unlock NAME    reconnect, which signs in again
  babysit windows password NAME                 type the stored password into the focused field (also a run step)
  babysit windows close NAME                    disconnect Remote Desktop (apps keep running on the PC)

The screen is a Remote Desktop session that stays connected between calls; the first call
connects (a few seconds). One Remote Desktop session per account: another session or a
person signing in takes it over. SSH runs outside the desktop: GUI apps started over ssh are
invisible, use the GUI commands for anything on screen.`

/**
 * One profile per kind (names match DEVICE_KINDS). `remote` is the scp
 * prefix; `ssh_actions` are the structured verbs on top of the GUI ones.
 */
export const KINDS = {
    mac: {
        name: `mac`, label: `Mac`, plural: `Macs`, registry: `macs.json`, key: `macs`,
        env: `BABYSIT_MAC`, root_env: `BABYSIT_MAC_ROOT`, remote: `mac:`,
        ssh_actions: [ `ssh`, `sudo`, `scp` ], help: mac_help,
    },
    windows: {
        name: `windows`, label: `Windows PC`, plural: `Windows PCs`, registry: `windows.json`, key: `machines`,
        env: `BABYSIT_WINDOWS`, root_env: `BABYSIT_WINDOWS_ROOT`, remote: `win:`,
        ssh_actions: [ `ssh`, `ps`, `scp` ], gui_actions: [ `close` ], help: windows_help,
    },
}

const default_root = kind => process.env[ kind.root_env ] || `${ homedir() }/.config/babysit-${ kind.name }`

// ---------------------------------------------------------------------------
// Registry

export const load_remotes = async ( kind, root ) => {
    try {
        return JSON.parse( await readFile( `${ root }/${ kind.registry }`, `utf8` ) )[ kind.key ] ?? []
    } catch {
        return []
    }
}

// Mac shorthand kept for older callers
export const load_macs = root => load_remotes( KINDS.mac, root )

// Without credentials the session either never asked for the kind, or its memory-only
// copy is gone (the container restarted, or the machine was disabled or forgotten)
const none_message = kind => process.env[ kind.env ] === `1`
    ? `This session asked for --${ kind.name } but holds no ${ kind.label } credentials: the container restarted, or the ${ kind.label } was disabled/forgotten on the host (babysit ${ kind.name } list). Relaunch the session.`
    : `No ${ kind.plural } in this session: start it with --${ kind.name } or --devices (after babysit ${ kind.name } add on the host)`

const find_remote = async ( kind, root, name ) => {
    const machines = await load_remotes( kind, root )
    const machine = machines.find( entry => [ entry.name, entry.host ].includes( name ) )
    if( !machine ) throw new Error( machines.length
        ? `Unknown ${ kind.label } ${ name }; registered: ${ machines.map( entry => entry.name ).join( `, ` ) }`
        : none_message( kind ) )
    return machine
}

// Options shared by ssh and scp. accept-new pins the host key on first contact.
const ssh_options = ( root, machine ) => [
    `-i`, `${ root }/${ machine.name }/id_ed25519`,
    `-o`, `IdentitiesOnly=yes`,
    `-o`, `UserKnownHostsFile=${ root }/${ machine.name }/known_hosts`,
    `-o`, `StrictHostKeyChecking=accept-new`,
    `-o`, `BatchMode=yes`,
    `-o`, `ConnectTimeout=10`,
]

// UTF-16LE base64: survives cmd.exe and PowerShell (either may be sshd's DefaultShell) unparsed
export const encode_powershell = script => Buffer.from( script, `utf16le` ).toString( `base64` )

// A fixed launcher that runs whatever script arrives on stdin, with UTF-8 both ways
const POWERSHELL_STDIN = [ `powershell`, `-NoProfile`, `-NonInteractive`, `-EncodedCommand`, encode_powershell( [
    // Setting console encodings can throw without a console (no pty), so only try
    `try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false } catch {}`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$reader = New-Object IO.StreamReader ([Console]::OpenStandardInput()), ([Text.Encoding]::UTF8)`,
    `Invoke-Expression $reader.ReadToEnd()`,
].join( `; ` ) ) ]

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

// Always destroy: a timed-out socket left open keeps the process alive past its answer
export const default_reachable = ( host, port ) => new Promise( resolve => {
    const socket = connect( { host, port, timeout: 2_000 } )
    const done = up => {
        resolve( up )
        socket.destroy()
    }
    socket.on( `connect`, () => done( true ) ).on( `timeout`, () => done( false ) ).on( `error`, () => done( false ) )
} )

const read_stdin = async () => {
    let text = ``
    for await ( const chunk of process.stdin ) text += chunk
    return text
}

// ---------------------------------------------------------------------------
// Commands

const list = async ( kind, io ) => {

    const machines = await load_remotes( kind, io.root )
    if( !machines.length ) {
        io.say( none_message( kind ) )
        return 0
    }

    for( const machine of machines ) {
        const { port, label } = SCREEN[ kind.name ]
        const [ ssh, gui ] = await Promise.all( [ io.reachable( machine.host, 22 ), io.reachable( machine.host, port ) ] )
        io.say( `${ machine.name }  ${ machine.user }@${ machine.host }  ssh:${ ssh ? `up` : `down` }  ${ label }:${ gui ? `up` : `down` }` )
    }
    return 0

}

/**
 * Run a `babysit mac|windows` command.
 * @param {Object} kind - A KINDS profile
 * @param {string[]} args - Arguments after the kind
 * @param {Object} [io] - Seams: root, run, reachable, say, stdin
 * @returns {Promise<number>} Exit code
 */
export const run_remote = async ( kind, args, io = {} ) => {

    io = { root: default_root( kind ), run: default_run, reachable: default_reachable, say: console.log, stdin: read_stdin, ...io }
    const [ action, name, ...rest ] = args

    if( !action || [ `help`, `--help`, `-h` ].includes( action ) ) return io.say( kind.help ), 0
    if( action === `list` ) return list( kind, io )
    if( ![ ...kind.ssh_actions, ...GUI, ...kind.gui_actions ?? [] ].includes( action ) ) throw new Error( `Unknown ${ kind.name } command ${ action }\n${ kind.help }` )
    if( !name ) throw new Error( `Usage: babysit ${ kind.name } ${ action } NAME ...` )

    const machine = await find_remote( kind, io.root, name )
    const target = `${ machine.user }@${ machine.host }`
    const ssh = extra => io.run( `ssh`, [ ...ssh_options( io.root, machine ), target, ...extra ] )

    if( action === `ssh` ) return ssh( rest )

    if( action === `sudo` ) {
        if( !rest.length ) throw new Error( `Usage: babysit mac sudo NAME cmd...` )
        const password = ( await readFile( `${ io.root }/${ machine.name }/password`, `utf8` ) ).replace( /\n$/, `` )
        // -S reads the password from stdin; -p '' keeps the prompt out of the output
        return io.run( `ssh`, [ ...ssh_options( io.root, machine ), target, `sudo`, `-S`, `-p`, `''`, ...rest ], { input: `${ password }\n` } )
    }

    if( action === `ps` ) {
        const script = rest.length ? rest.join( ` ` ) : await io.stdin()
        if( !script.trim() ) throw new Error( `Usage: babysit windows ps NAME 'script' (or the script on stdin)` )
        // The script rides stdin, so cmd.exe's 8191-character line limit never applies
        return io.run( `ssh`, [ ...ssh_options( io.root, machine ), target, ...POWERSHELL_STDIN ], { input: script } )
    }

    if( action === `scp` ) {
        if( rest.length < 2 ) throw new Error( `Usage: babysit ${ kind.name } scp NAME SRC DST (remote paths start with ${ kind.remote })` )
        const remote = path => path.startsWith( kind.remote ) ? `${ target }:${ path.slice( kind.remote.length ) }` : path
        return io.run( `scp`, [ `-r`, ...ssh_options( io.root, machine ), ...rest.map( remote ) ] )
    }

    // vnc.py serves both kinds' registries, so it needs --kind; rdp.py is Windows-only
    const { helper } = SCREEN[ kind.name ]
    const kind_args = helper === `vnc.py` ? [ `--kind`, kind.name ] : []
    return io.run( `python3`, [ `${ HELPERS }/${ helper }`, ...kind_args, machine.name, action, ...rest ] )

}

export const run_mac = ( args, io ) => run_remote( KINDS.mac, args, io )
export const run_windows = ( args, io ) => run_remote( KINDS.windows, args, io )
