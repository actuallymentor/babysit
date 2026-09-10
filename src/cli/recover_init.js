import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { run } from '../utils/exec.js'
import { resolve_babysit_home } from '../utils/paths.js'

// systemd applies specifier expansion even inside quotes. Exec arguments also
// expand dollars; Environment= values do not.
const unit_quote = ( value, argument = false ) => {
    if( /[\x00-\x1f\x7f]/.test( value ) ) throw new Error( `Service configuration cannot contain control characters` )
    const escaped = String( value ).replaceAll( `\\`, `\\\\` ).replaceAll( `"`, `\\"` ).replaceAll( `%`, `%%` )
    return `"${ argument ? escaped.replaceAll( `$`, () => `$$` ) : escaped }"`
}

/** Render one account's boot recovery unit; all launch paths must be absolute. */
export const render_recovery_service = ( { uid, gid, home, babysit_home = resolve_babysit_home( home ), command, path, workspaces = [], tmux_socket = `babysit` } ) => {
    if( !Number.isInteger( uid ) || uid < 0 || !Number.isInteger( gid ) || gid < 0 ) throw new Error( `Invalid service account` )
    if( !isAbsolute( home ) || !command?.length || command.some( item => !isAbsolute( item ) ) ) throw new Error( `Recovery service requires absolute home and executable paths` )
    babysit_home = resolve_babysit_home( home, babysit_home )
    const launch = command.map( ( item, index ) => unit_quote( item, index > 0 ) ).join( ` ` )
    const mounts = [ ...new Set( [ home, babysit_home, ...command.map( dirname ), ...workspaces.filter( isAbsolute ) ] ) ]

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
Environment=${ unit_quote( `BABYSIT_HOME=${ babysit_home }` ) }
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
export const install_recovery_service = async ( { unit, uid, privileged = process.getuid() === 0 }, {
    execute = run, interactive = Boolean( process.stdin.isTTY ),
} = {} ) => {
    const name = `babysit-recover-${ uid }.service`
    const directory = mkdtempSync( join( tmpdir(), `babysit-recover-` ) )
    const source = join( directory, name )
    const destination = `/etc/systemd/system/${ name }`
    // Sudo owns its terminal prompt; Babysit never reads or stores the password.
    const sudo = args => execute( `/usr/bin/sudo`, [ ... interactive ? [] : [ `-n` ], ...args ],
        interactive ? { stdio: [ `inherit`, `pipe`, `pipe` ] } : {}, interactive ? 300_000 : 30_000 )
    const admin = ( command, args ) => privileged ? execute( command, args ) : sudo( [ `--`, command, ...args ] )

    try {
        writeFileSync( source, unit, { mode: 0o600 } )
        // Authenticate before writing configuration, allowing the usual password
        // prompt in a terminal while unattended invocations remain nonblocking.
        if( !privileged ) {
            try {
                await sudo( [ `-v` ] )
            } catch ( error ) {
                const hint = interactive ? `Sudo authentication failed; retry babysit recover init.`
                    : `Sudo authorization is required. Run babysit recover init in a terminal, or use root/passwordless sudo for unattended installation.`
                throw new Error( `${ hint }\n${ error.message }`, { cause: error } )
            }
        }
        await admin( `/usr/bin/install`, [ `-o`, `root`, `-g`, `root`, `-m`, `0644`, source, destination ] )
        await admin( `/usr/bin/systemctl`, [ `daemon-reload` ] )
        await admin( `/usr/bin/systemctl`, [ `enable`, name ] )
        return { name, destination }
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }
}

const workspace_mounts = babysit_home => {
    const directory = join( babysit_home, `sessions` )
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

/** Verify boot executables with the service account's environment, before sudo installation. */
export const check_recovery_environment = async ( { uid, username, home, babysit_home = resolve_babysit_home( home ), path, command }, {
    execute = run, current_uid = process.getuid(),
} = {} ) => {
    // Clear login-only configuration *after* runuser/PAM. Otherwise root's
    // Docker config or loader settings can make a probe pass that fails at boot.
    const environment = [ `HOME=${ home }`, `BABYSIT_HOME=${ babysit_home }`, `USER=${ username }`, `LOGNAME=${ username }`, `PATH=${ path }`, `DOCKER_HOST=unix:///var/run/docker.sock` ]
    const as_user = ( binary, args ) => {
        const invocation = [ `-i`, ...environment, binary, ...args ]
        return current_uid === 0 && uid !== 0
            ? execute( `/usr/sbin/runuser`, [ `--user`, username, `--`, `/usr/bin/env`, ...invocation ], { cwd: home } )
            : execute( `/usr/bin/env`, invocation, { cwd: home } )
    }

    const dependencies = []
    const check = async ( label, binary, args ) => {
        try {
            return await as_user( binary, args )
        } catch ( error ) {
            throw new Error( `Boot recovery prerequisite failed for ${ username }: ${ label }. Ensure dependencies are installed and accessible, then run babysit recover init as ${ username } without a sudo prefix to capture that user's PATH.\n${ error.message }`, { cause: error } )
        }
    }

    await check( `home directory access`, `/usr/bin/test`, [ `-r`, home, `-a`, `-x`, home ] )
    await check( `Babysit executable`, command[ 0 ], [ ...command.slice( 1 ), `--version` ] )
    // Agent CLIs run inside Docker; only these host tools are needed by recovery.
    const probes = [
        [ `sh`, [ `-c`, `true` ] ],
        [ `tmux`, [ `-V` ] ],
        [ `docker`, [ `--version` ] ],
        [ `cat`, [ `--version` ] ],
        [ `ps`, [ `--version` ] ],
    ]
    for( const [ binary, args ] of probes ) {
        const location = await check( `${ binary } on the service PATH`, `/bin/sh`, [ `-c`, `command -v "$1"`, `sh`, binary ] )
        if( !isAbsolute( location ) ) throw new Error( `Boot recovery requires an absolute executable for ${ binary }; got ${ location }` )
        await check( binary, location, args )
        dependencies.push( location )
    }
    await check( `Docker access`, `docker`, [ `--host`, `unix:///var/run/docker.sock`, `info`, `--format`, `{{.ID}}` ] )
    return dependencies
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
    const account = await execute( `/usr/bin/getent`, [ `passwd`, String( uid ) ] )
    const [ username, , account_uid, account_gid, , home ] = account.trim().split( `:` )
    if( Number( account_uid ) !== uid || !home || !username ) throw new Error( `Cannot resolve invoking account ${ uid }` )
    const gid = Number( account_gid )
    const babysit_home = resolve_babysit_home( home )
    const compiled = !process.argv[ 1 ] || process.argv[ 1 ].startsWith( `/$bunfs` )
    const command = compiled ? [ process.execPath ] : [ process.execPath, resolve( process.argv[ 1 ] ) ]
    const path = [ ...new Set( [ join( home, `.local`, `bin` ), ...command.map( dirname ), ...( process.env.PATH || `` ).split( `:` ).filter( isAbsolute ), `/usr/local/bin`, `/usr/bin`, `/bin` ] ) ].join( `:` )

    await execute( `/usr/bin/systemctl`, [ `show`, `docker.service`, `--property=LoadState`, `--value` ] ).then( state => {
        if( state !== `loaded` ) throw new Error( `The system Docker service is not installed` )
    } )
    const dependencies = await check_recovery_environment( { uid, username, home, babysit_home, path, command }, { execute } )

    const unit = render_recovery_service( { uid, gid, home, babysit_home, command, path, workspaces: [ ...workspace_mounts( babysit_home ), ...dependencies.map( dirname ) ], tmux_socket: process.env.BABYSIT_TMUX_SOCKET || `babysit` } )
    const installed = await install( { unit, uid }, { execute } )
    print( `Enabled ${ installed.name } for ${ username }; recovery runs on the next boot.` )
    print( `Babysit storage: ${ babysit_home }` )
    print( `Logs: journalctl -u ${ installed.name }` )
    print( `Run babysit recover now to recover interrupted sessions immediately.` )
    print( `Rerun babysit recover init after changing BABYSIT_HOME, moving the executable, or adding workspace mounts.` )
    return installed
}
