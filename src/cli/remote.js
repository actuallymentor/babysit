import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'

import { REMOTE_KINDS, add_remote, forget_remote, list_remotes, set_remote_enabled } from '../remote/store.js'

// Always destroy: a timed-out socket left open keeps the process alive past its answer
const reachable = ( host, port ) => new Promise( resolve => {

    const socket = connect( { host, port, timeout: 2_000 } )
    const done = up => {
        resolve( up )
        socket.destroy()
    }
    socket.on( `connect`, () => done( true ) ).on( `timeout`, () => done( false ) ).on( `error`, () => done( false ) )

} )

const read_stdin = () => readFileSync( 0, `utf8` ).replace( /\r?\n$/, `` )

// ---------------------------------------------------------------------------
// Per-kind host setup: how to authorize the key, and what to tell the user

// POSIX: append to ~/.ssh/authorized_keys once
const authorize_posix = pub => `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '${ pub }' ~/.ssh/authorized_keys || echo '${ pub }' >> ~/.ssh/authorized_keys`

/**
 * Windows OpenSSH reads administrators' keys from one machine-wide file that
 * must be owned by Administrators/SYSTEM only (sshd ignores it otherwise);
 * standard users use ~\.ssh\authorized_keys. Sent as -EncodedCommand (UTF-16LE
 * base64) so neither cmd.exe nor PowerShell (whichever is sshd's DefaultShell)
 * re-parses the quoting. SIDs (Administrators, SYSTEM) keep it working on
 * localized Windows.
 */
export const authorize_windows = pub => {

    const script = [
        `$k = '${ pub }'`,
        `$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
        `if ($admin) { $f = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' } else { $d = Join-Path $HOME '.ssh'; New-Item -ItemType Directory -Force $d | Out-Null; $f = Join-Path $d 'authorized_keys' }`,
        // A last line without a newline would swallow the appended key
        `$raw = if (Test-Path $f) { [IO.File]::ReadAllText($f) } else { '' }`,
        `if (-not $raw.Contains($k)) { if ($raw -and -not $raw.EndsWith([string][char]10)) { $k = [Environment]::NewLine + $k }; Add-Content -Path $f -Value $k -Encoding ascii }`,
        // Replace the whole DACL: icacls /grant would keep foreign explicit grants, and sshd rejects the file then
        `if ($admin) { $acl = New-Object Security.AccessControl.FileSecurity; $acl.SetAccessRuleProtection($true, $false); foreach ($sid in 'S-1-5-32-544', 'S-1-5-18') { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier $sid), 'FullControl', 'Allow'))) }; Set-Acl -Path $f -AclObject $acl }`,
    ].join( `\n` )

    return `powershell -NoProfile -NonInteractive -EncodedCommand ${ Buffer.from( script, `utf16le` ).toString( `base64` ) }`

}

const SETUP = {
    mac: {
        authorize: authorize_posix,
        ssh_down: `Turn on Remote Login: System Settings > General > Sharing`,
        vnc_down: `Turn on Screen Sharing: System Settings > General > Sharing`,
        vnc_label: `Screen Sharing`,
    },
    windows: {
        authorize: authorize_windows,
        ssh_down: `Install and start OpenSSH Server (see babysit windows --help)`,
        vnc_down: `Install a VNC server, e.g. TightVNC as a service, password = the account password's first 8 characters (see babysit windows --help)`,
        vnc_label: `VNC`,
    },
}

// ---------------------------------------------------------------------------
// ssh plumbing

// Host key pinned per machine on first contact (accept-new)
const ssh_args = ( dir, machine, extra = [] ) => [
    `-o`, `UserKnownHostsFile=${ join( dir, machine.name, `known_hosts` ) }`,
    `-o`, `StrictHostKeyChecking=accept-new`,
    `-o`, `ConnectTimeout=10`,
    ...extra,
    `${ machine.user }@${ machine.host }`,
]

// `exit 0` means the same in sh, cmd.exe and PowerShell
const key_login_works = ( dir, machine ) => spawnSync( `ssh`, [ ...ssh_args( dir, machine, [
    `-i`, join( dir, machine.name, `id_ed25519` ), `-o`, `IdentitiesOnly=yes`, `-o`, `BatchMode=yes`,
] ), `exit 0` ], { encoding: `utf8`, input: ``, timeout: 20_000 } ).status === 0

// Password login through SSH_ASKPASS (a 0700 script that cats the 0600 password
// file), so the secret never touches argv or the environment.
const install_key = ( setup, dir, machine ) => {

    const helper = mkdtempSync( join( tmpdir(), `babysit-askpass-` ) )

    try {
        const askpass = join( helper, `askpass.sh` )
        writeFileSync( askpass, `#!/bin/sh\nexec cat '${ join( dir, machine.name, `password` ) }'\n`, { mode: 0o700 } )
        chmodSync( askpass, 0o700 )

        const pub = readFileSync( join( dir, machine.name, `id_ed25519.pub` ), `utf8` ).trim()
        const { status, stderr, error, signal } = spawnSync( `ssh`, [
            ...ssh_args( dir, machine, [
                `-o`, `PubkeyAuthentication=no`,
                `-o`, `PreferredAuthentications=password,keyboard-interactive`,
                `-o`, `NumberOfPasswordPrompts=1`,
            ] ),
            setup.authorize( pub ),
        ], {
            encoding: `utf8`,
            env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: `force`, DISPLAY: process.env.DISPLAY || `:0` },
            input: ``,
            timeout: 30_000,
        } )

        return status === 0 ? null : ( stderr || `` ).trim().split( `\n` ).pop() || ( error ? `ssh ${ error.code || error.message }${ error.code === `ETIMEDOUT` ? ` after 30s, no answer` : `` }` : `ssh exited ${ status ?? `by ${ signal }` }` )
    } finally {
        rmSync( helper, { recursive: true, force: true } )
    }

}

/**
 * Verify one machine: SSH reachable, key installed (installing it with the
 * stored password when needed), VNC reachable.
 * @returns {Promise<boolean>} Whether SSH and VNC both work
 */
const check_remote = async ( kind, dir, machine, print, ports ) => {

    const setup = SETUP[ kind.name ]
    const [ ssh_up, vnc_up ] = await Promise.all( [ ports( machine.host, 22 ), ports( machine.host, 5900 ) ] )
    let ssh_ok = false

    if( !ssh_up ) print( `${ machine.name }: ssh down (22). ${ setup.ssh_down }` )
    else if( key_login_works( dir, machine ) ) ssh_ok = true
    else {
        const failure = install_key( setup, dir, machine )
        ssh_ok = !failure && key_login_works( dir, machine )
        print( ssh_ok ? `${ machine.name }: ssh key installed` : `${ machine.name }: could not install the ssh key (${ failure || `key login still refused` })` )
    }

    if( !vnc_up ) print( `${ machine.name }: ${ setup.vnc_label } down (5900). ${ setup.vnc_down }` )
    if( ssh_ok && vnc_up ) print( `${ machine.name }: ok (ssh key, ${ setup.vnc_label } port)` )

    return ssh_ok && vnc_up

}

/**
 * babysit mac|windows add|list|check|enable|disable|forget
 * @param {Object} kind - A REMOTE_KINDS profile
 * @param {Object} cmd - Parsed command (remote_verb, remote_name, remote_host, ...)
 * @param {Object} [deps] - Seams: dir, print, ports, read_password
 * @returns {Promise<number>} Exit code
 */
export const cmd_remote = async ( kind, cmd, {
    dir = kind.dir,
    print = console.log,
    ports = reachable,
    read_password = null,
} = {} ) => {

    const { remote_verb: verb, remote_name: name } = cmd

    if( verb === `add` ) {
        const password = cmd.password_env ? process.env[ cmd.password_env ]
            : cmd.password_stdin ? ( read_password || read_stdin )()
                : null
        if( !password ) throw new Error( cmd.password_env
            ? `${ cmd.password_env } is empty`
            : `No password: pipe it with --password-stdin, or name an environment variable with --password-env VAR (e.g. read -rs PW; PW=$PW babysit ${ kind.name } add ... --password-env PW)` )

        const machine = add_remote( kind, { name, host: cmd.remote_host, user: cmd.user || userInfo().username, password }, dir )
        print( `Added ${ machine.name } (${ machine.user }@${ machine.host }). Secrets: ${ dir }/${ machine.name } (0700); sessions get them only with --${ kind.name } or --devices.` )

        return await check_remote( kind, dir, machine, print, ports ) ? 0 : 1
    }

    if( [ `enable`, `disable` ].includes( verb ) ) {
        const found = set_remote_enabled( kind, name, verb === `enable`, dir )
        print( found ? `${ name } ${ verb }d: sessions ${ verb === `enable` ? `now receive` : `no longer receive` } its secrets.` : `No ${ kind.label } named ${ name }.` )
        return found ? 0 : 1
    }

    if( verb === `forget` ) {
        print( forget_remote( kind, name, dir ) ? `Forgot ${ name }.` : `No ${ kind.label } named ${ name }.` )
        return 0
    }

    const machines = list_remotes( kind, dir ).filter( machine => !name || machine.name === name )
    if( !machines.length ) {
        print( name ? `No ${ kind.label } named ${ name }.` : `No ${ kind.plural }. Add one with: babysit ${ kind.name } add NAME HOST --user USER --password-stdin` )
        return name ? 1 : 0
    }

    if( verb === `check` ) {
        const results = []
        for( const machine of machines ) results.push( await check_remote( kind, dir, machine, print, ports ) )
        return results.every( Boolean ) ? 0 : 1
    }

    for( const machine of machines ) {
        const [ ssh_up, vnc_up ] = await Promise.all( [ ports( machine.host, 22 ), ports( machine.host, 5900 ) ] )
        print( `${ machine.name }  ${ machine.user }@${ machine.host }  ssh:${ ssh_up ? `up` : `down` }  vnc:${ vnc_up ? `up` : `down` }${ machine.enabled === false ? `  disabled (sessions do not get its secrets)` : `` }` )
    }
    return 0

}

export const cmd_mac = ( cmd, deps ) => cmd_remote( REMOTE_KINDS.mac, cmd, deps )
export const cmd_windows = ( cmd, deps ) => cmd_remote( REMOTE_KINDS.windows, cmd, deps )
