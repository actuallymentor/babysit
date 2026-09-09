import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { run } from '../utils/exec.js'

// systemd applies specifier expansion even inside quotes. Exec arguments also
// expand dollars; Environment= values do not.
const unit_quote = ( value, argument = false ) => {
    if( /[\x00-\x1f\x7f]/.test( value ) ) throw new Error( `Service configuration cannot contain control characters` )
    const escaped = String( value ).replaceAll( `\\`, `\\\\` ).replaceAll( `"`, `\\"` ).replaceAll( `%`, `%%` )
    return `"${ argument ? escaped.replaceAll( `$`, () => `$$` ) : escaped }"`
}

/** Render one account's boot recovery unit; all launch paths must be absolute. */
export const render_recovery_service = ( { uid, gid, home, command, path, workspaces = [], tmux_socket = `babysit` } ) => {
    if( !Number.isInteger( uid ) || uid < 0 || !Number.isInteger( gid ) || gid < 0 ) throw new Error( `Invalid service account` )
    if( !isAbsolute( home ) || !command?.length || command.some( item => !isAbsolute( item ) ) ) throw new Error( `Recovery service requires absolute home and executable paths` )
    const launch = command.map( ( item, index ) => unit_quote( item, index > 0 ) ).join( ` ` )
    const mounts = [ ...new Set( [ home, ...command.map( dirname ), ...workspaces.filter( isAbsolute ) ] ) ]

    // Let boot proceed once exec succeeds; keep recovered children after the
    // bounded sweep exits. A long batch must not hit a startup timeout.
    return `[Unit]
Description=Babysit session recovery for UID ${ uid }
Wants=network-online.target docker.service
After=network-online.target docker.service
RequiresMountsFor=${ mounts.map( item => unit_quote( item ) ).join( ` ` ) }

[Service]
Type=exec
RemainAfterExit=yes
User=${ uid }
Group=${ gid }
WorkingDirectory=${ home.replaceAll( `%`, `%%` ) }
Environment=${ unit_quote( `HOME=${ home }` ) }
Environment=${ unit_quote( `PATH=${ path }` ) }
Environment=${ unit_quote( `BABYSIT_TMUX_SOCKET=${ tmux_socket }` ) }
Environment="DOCKER_HOST=unix:///var/run/docker.sock"
ExecStart=${ launch } recover --boot
ExecStop=${ launch } recover --shutdown
TimeoutStartSec=30
TimeoutStopSec=120
KillMode=control-group
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`
}

/** Install and enable a unit without disturbing currently running sessions. */
export const install_recovery_service = async ( { unit, uid, privileged = process.getuid() === 0 }, { execute = run } = {} ) => {
    const name = `babysit-recover-${ uid }.service`
    const directory = mkdtempSync( join( tmpdir(), `babysit-recover-` ) )
    const source = join( directory, name )
    const destination = `/etc/systemd/system/${ name }`
    const admin = ( command, args ) => privileged ? execute( command, args ) : execute( `sudo`, [ `-n`, `--`, command, ...args ] )

    try {
        writeFileSync( source, unit, { mode: 0o600 } )
        // Fail before writing configuration when sudo would require a password.
        if( !privileged ) await execute( `sudo`, [ `-n`, `true` ] )
        await admin( `install`, [ `-o`, `root`, `-g`, `root`, `-m`, `0644`, source, destination ] )
        await admin( `systemctl`, [ `daemon-reload` ] )
        await admin( `systemctl`, [ `enable`, name ] )
        return { name, destination }
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }
}

const workspace_mounts = home => {
    const directory = join( home, `.babysit`, `sessions` )
    if( !existsSync( directory ) ) return []
    return readdirSync( directory ).filter( name => name.endsWith( `.json` ) ).flatMap( name => {
        try {
            const record = JSON.parse( readFileSync( join( directory, name ), `utf8` ) )
            if( !record.expected_open || record.superseded_by ) return []
            return [ record.original_pwd || record.pwd, record.clone_path ].filter( path => typeof path === `string` && isAbsolute( path ) )
        } catch {
            // A broken legacy record must not prevent installing boot recovery.
            return []
        }
    } )
}

/** Install Ubuntu boot recovery for the invoking account, including through sudo. */
export const cmd_recover_init = async ( _cmd = {}, { execute = run, install = install_recovery_service, print = console.log } = {} ) => {
    if( process.platform !== `linux` || !existsSync( `/run/systemd/system` ) ) throw new Error( `babysit recover init requires an Ubuntu host running systemd` )
    const release = readFileSync( `/etc/os-release`, `utf8` )
    if( !/^ID=["']?ubuntu["']?$/m.test( release ) ) throw new Error( `babysit recover init currently supports Ubuntu hosts` )
    if( process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== `default` || process.env.DOCKER_HOST && process.env.DOCKER_HOST !== `unix:///var/run/docker.sock` ) throw new Error( `Boot recovery requires the local system Docker daemon; rootless and remote Docker are unsupported` )

    // Resolve HOME from the account database, never sudo's root HOME.
    const uid = process.getuid() === 0 && process.env.SUDO_UID ? Number( process.env.SUDO_UID ) : process.getuid()
    if( !Number.isInteger( uid ) || uid < 0 ) throw new Error( `Invalid invoking user ID` )
    const account = await execute( `getent`, [ `passwd`, String( uid ) ] )
    const [ username, , account_uid, account_gid, , home ] = account.trim().split( `:` )
    if( Number( account_uid ) !== uid || !home || !username ) throw new Error( `Cannot resolve invoking account ${ uid }` )
    const gid = Number( account_gid )
    const compiled = !process.argv[ 1 ] || process.argv[ 1 ].startsWith( `/$bunfs` )
    const command = compiled ? [ process.execPath ] : [ process.execPath, resolve( process.argv[ 1 ] ) ]
    command.forEach( file => accessSync( file, constants.R_OK ) )
    const path = [ ...new Set( [ join( home, `.local`, `bin` ), ...command.map( dirname ), ...( process.env.PATH || `` ).split( `:` ).filter( isAbsolute ), `/usr/local/bin`, `/usr/bin`, `/bin` ] ) ].join( `:` )

    await execute( `systemctl`, [ `show`, `docker.service`, `--property=LoadState`, `--value` ] ).then( state => {
        if( state !== `loaded` ) throw new Error( `The system Docker service is not installed` )
    } )
    // Check access as the service account, including sudo's original user. A
    // successful root probe would otherwise hide missing Docker membership.
    const as_user = ( binary, args ) => process.getuid() === 0 && uid !== 0
        ? execute( `runuser`, [ `--user`, username, `--`, binary, ...args ], { env: { ...process.env, HOME: home, PATH: path } } )
        : execute( binary, args, { env: { ...process.env, HOME: home, PATH: path } } )
    await as_user( `test`, [ `-x`, command[ 0 ] ] )
    if( command[ 1 ] ) await as_user( `test`, [ `-r`, command[ 1 ] ] )
    await as_user( `docker`, [ `--host`, `unix:///var/run/docker.sock`, `info`, `--format`, `{{.ID}}` ] )

    const unit = render_recovery_service( { uid, gid, home, command, path, workspaces: workspace_mounts( home ), tmux_socket: process.env.BABYSIT_TMUX_SOCKET || `babysit` } )
    const installed = await install( { unit, uid }, { execute } )
    print( `Enabled ${ installed.name } for ${ username }; recovery runs on the next boot.` )
    print( `Logs: journalctl -u ${ installed.name }` )
    print( `Run babysit recover now to recover interrupted sessions immediately.` )
    print( `Rerun babysit recover init after moving the executable or adding workspace mounts.` )
    return installed
}
