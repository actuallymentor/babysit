import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { run } from '../utils/exec.js'
import { resolve_babysit_home } from '../utils/paths.js'
import { INHIBIT_DELAY_SEC } from '../sessions/recovery.js'

// systemd applies specifier expansion even inside quotes. Exec arguments also
// expand dollars; Environment= values do not.
export const unit_quote = ( value, argument = false ) => {
    if( /[\x00-\x1f\x7f]/.test( value ) ) throw new Error( `Service configuration cannot contain control characters` )
    const escaped = String( value ).replaceAll( `\\`, `\\\\` ).replaceAll( `"`, `\\"` ).replaceAll( `%`, `%%` )
    return `"${ argument ? escaped.replaceAll( `$`, () => `$$` ) : escaped }"`
}

// The parts both units share: who runs, with what environment, on which mounts
const service_account = ( { uid, gid, home, babysit_home = resolve_babysit_home( home ), command, path, workspaces = [], tmux_socket = `babysit` } ) => {

    if( !Number.isInteger( uid ) || uid < 0 || !Number.isInteger( gid ) || gid < 0 ) throw new Error( `Invalid service account` )
    if( !isAbsolute( home ) || !command?.length || command.some( item => !isAbsolute( item ) ) ) throw new Error( `Recovery service requires absolute home and executable paths` )
    const storage = resolve_babysit_home( home, babysit_home )
    const mounts = [ ...new Set( [ home, storage, ...command.map( dirname ), ...workspaces.filter( isAbsolute ) ] ) ]

    return {
        launch: command.map( ( item, index ) => unit_quote( item, index > 0 ) ).join( ` ` ),
        // Behind a wrapper the executable is an argument too, so dollars expand
        wrapped_launch: command.map( item => unit_quote( item, true ) ).join( ` ` ),
        mounts: `RequiresMountsFor=${ mounts.map( item => unit_quote( item ) ).join( ` ` ) }`,
        account: `User=${ uid }
Group=${ gid }
WorkingDirectory=${ home.replaceAll( `%`, `%%` ) }
Environment=${ unit_quote( `HOME=${ home }` ) }
Environment=${ unit_quote( `BABYSIT_HOME=${ storage }` ) }
Environment=${ unit_quote( `PATH=${ path }` ) }
Environment=${ unit_quote( `BABYSIT_TMUX_SOCKET=${ tmux_socket }` ) }`,
    }

}

/** Render one account's boot recovery unit; all launch paths must be absolute. */
export const render_recovery_service = settings => {

    const { launch, mounts, account } = service_account( settings )

    // Let boot proceed once exec succeeds; keep recovered children after the
    // bounded sweep exits. A long batch must not hit a startup timeout.
    return `[Unit]
Description=Babysit session recovery for UID ${ settings.uid }
Wants=network-online.target docker.service
After=network-online.target docker.service
${ mounts }

[Service]
Type=exec
RemainAfterExit=yes
${ account }
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

/**
 * Render the reboot notice unit: a watcher holding a logind delay lock, so a
 * clean shutdown waits while agents are told and wrap up. It is a separate
 * unit because the recovery unit's cgroup owns sessions; this one owns nothing
 * and can restart freely.
 */
export const render_notice_service = settings => {

    const { wrapped_launch, mounts, account } = service_account( settings )

    return `[Unit]
Description=Babysit reboot notice for UID ${ settings.uid }
After=systemd-logind.service
${ mounts }

[Service]
Type=exec
${ account }
ExecStart=/usr/bin/systemd-inhibit --what=shutdown --mode=delay --who=babysit "--why=Agents are saving their state" ${ wrapped_launch } recover --notify
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
`
}

// logind caps delay locks (5s upstream, 30s on Ubuntu); the notice needs longer
export const LOGIND_DROP_IN = `/etc/systemd/logind.conf.d/babysit-reboot-notice.conf`
export const render_logind_drop_in = () => `[Login]\nInhibitDelayMaxSec=${ INHIBIT_DELAY_SEC }\n`

/** Install and enable the units without disturbing currently running sessions. */
export const install_recovery_service = async ( { unit, notice_unit = null, uid, privileged = process.getuid() === 0 }, {
    execute = run, interactive = Boolean( process.stdin.isTTY ),
} = {} ) => {
    const name = `babysit-recover-${ uid }.service`
    const notice_name = `babysit-reboot-notice-${ uid }.service`
    const directory = mkdtempSync( join( tmpdir(), `babysit-recover-` ) )
    const destination = `/etc/systemd/system/${ name }`
    const files = [
        [ name, unit, destination ],
        ...notice_unit ? [
            [ notice_name, notice_unit, `/etc/systemd/system/${ notice_name }` ],
            [ `logind.conf`, render_logind_drop_in(), LOGIND_DROP_IN ],
        ] : [],
    ]
    // Sudo owns its terminal prompt; Babysit never reads or stores the password.
    const sudo = args => execute( `/usr/bin/sudo`, [ ... interactive ? [] : [ `-n` ], ...args ],
        interactive ? { stdio: [ `inherit`, `pipe`, `pipe` ] } : {}, interactive ? 300_000 : 30_000 )
    const admin = ( command, args ) => privileged ? execute( command, args ) : sudo( [ `--`, command, ...args ] )

    try {
        for( const [ file, content ] of files ) writeFileSync( join( directory, file ), content, { mode: 0o600 } )
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
        // -D creates logind.conf.d on hosts that never had a drop-in
        for( const [ file, , target ] of files ) await admin( `/usr/bin/install`, [ `-D`, `-o`, `root`, `-g`, `root`, `-m`, `0644`, join( directory, file ), target ] )
        await admin( `/usr/bin/systemctl`, [ `daemon-reload` ] )
        await admin( `/usr/bin/systemctl`, [ `enable`, name ] )
        if( !notice_unit ) return { name, destination }

        // The watcher owns no sessions, so unlike recovery it can start right away.
        // An older logind cannot reload; the raised cap then applies from the next boot.
        const reloaded = await admin( `/usr/bin/systemctl`, [ `reload`, `systemd-logind.service` ] ).then( () => true, () => false )
        await admin( `/usr/bin/systemctl`, [ `enable`, notice_name ] )
        await admin( `/usr/bin/systemctl`, [ `restart`, notice_name ] )
        return { name, destination, notice_name, reloaded }
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
    // New roots need a writable ancestor; existing roots must already be usable
    // by the boot account. Pass the path as data, never interpolate shell input.
    await check( `Babysit storage access`, `/bin/sh`, [ `-c`, `
        directory=$1
        while [ ! -e "$directory" ] && [ ! -L "$directory" ]; do
            directory=$(/usr/bin/dirname -- "$directory") || exit
        done
        test -d "$directory" && test -r "$directory" && test -w "$directory" && test -x "$directory"
    `, `sh`, babysit_home ] )
    await check( `Babysit executable`, command[ 0 ], [ ...command.slice( 1 ), `--version` ] )
    // Agent CLIs run inside Docker; only these host tools are needed by recovery.
    const probes = [
        [ `sh`, [ `-c`, `true` ] ],
        [ `tmux`, [ `-V` ] ],
        [ `docker`, [ `--version` ] ],
        [ `cat`, [ `--version` ] ],
        [ `ps`, [ `--version` ] ],
        // The reboot notice: a logind delay lock, and a listener for its signal
        [ `systemd-inhibit`, [ `--version` ] ],
        [ `gdbus`, [ `help` ] ],
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

    const settings = { uid, gid, home, babysit_home, command, path, workspaces: [ ...workspace_mounts( babysit_home ), ...dependencies.map( dirname ) ], tmux_socket: process.env.BABYSIT_TMUX_SOCKET || `babysit` }
    const installed = await install( { unit: render_recovery_service( settings ), notice_unit: render_notice_service( settings ), uid }, { execute } )
    print( `Enabled ${ installed.name } for ${ username }; recovery runs on the next boot.` )
    print( `Started ${ installed.notice_name }; agents get up to two minutes' notice before a clean shutdown or reboot${ installed.reloaded ? `` : ` (from the next boot)` }.` )
    print( `Babysit storage: ${ babysit_home }` )
    print( `Logs: journalctl -u ${ installed.name } -u ${ installed.notice_name }` )
    print( `Run babysit recover now to recover interrupted sessions immediately.` )
    print( `Rerun babysit recover init after changing BABYSIT_HOME, moving the executable, or adding workspace mounts.` )
    return installed
}
