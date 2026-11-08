import { spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir, userInfo } from 'os'
import { join } from 'path'

import { MACS_DIR, add_mac, forget_mac, list_macs } from '../mac/store.js'

const reachable = ( host, port ) => new Promise( resolve => {

    const socket = connect( { host, port, timeout: 2_000 } )
    socket.on( `connect`, () => {
        resolve( true ); socket.end() 
    } )
    socket.on( `timeout`, () => {
        resolve( false ); socket.destroy() 
    } )
    socket.on( `error`, () => resolve( false ) )

} )

const read_stdin = () => readFileSync( 0, `utf8` ).replace( /\r?\n$/, `` )

// Hidden prompt for an interactive add; pipes use --password-stdin instead
const prompt_password = () => new Promise( resolve => {

    let typed = ``
    process.stdout.write( `Mac account password: ` )
    process.stdin.setRawMode( true )
    process.stdin.resume()
    process.stdin.setEncoding( `utf8` )
    process.stdin.on( `data`, function listen( chunk ) {
        for( const char of chunk ) {
            if( char === `\u0003` ) process.exit( 130 )
            if( char === `\r` || char === `\n` ) {
                process.stdin.setRawMode( false )
                process.stdin.pause()
                process.stdin.removeListener( `data`, listen )
                process.stdout.write( `\n` )
                return resolve( typed )
            }
            typed = char === `\u007f` ? typed.slice( 0, -1 ) : typed + char
        }
    } )

} )

const ssh = ( dir, mac, args, options = {} ) => spawnSync( `ssh`, [
    `-o`, `UserKnownHostsFile=${ join( dir, mac.name, `known_hosts` ) }`,
    `-o`, `StrictHostKeyChecking=accept-new`,
    `-o`, `ConnectTimeout=10`,
    ...args,
    `${ mac.user }@${ mac.host }`,
], { encoding: `utf8`, ...options } )

const key_login_works = ( dir, mac ) => ssh( dir, mac, [
    `-i`, join( dir, mac.name, `id_ed25519` ), `-o`, `IdentitiesOnly=yes`, `-o`, `BatchMode=yes`,
], { input: ``, timeout: 20_000 } ).status === 0

// Password login through SSH_ASKPASS (a 0700 script that cats the 0600 password
// file), so the secret never touches argv or the environment.
const install_key = ( dir, mac ) => {

    const helper = mkdtempSync( join( tmpdir(), `babysit-askpass-` ) )

    try {
        const askpass = join( helper, `askpass.sh` )
        writeFileSync( askpass, `#!/bin/sh\nexec cat '${ join( dir, mac.name, `password` ) }'\n`, { mode: 0o700 } )
        chmodSync( askpass, 0o700 )

        const pub = readFileSync( join( dir, mac.name, `id_ed25519.pub` ), `utf8` ).trim()
        const remote = `umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '${ pub }' ~/.ssh/authorized_keys || echo '${ pub }' >> ~/.ssh/authorized_keys`
        const { status, stderr } = spawnSync( `ssh`, [
            `-o`, `UserKnownHostsFile=${ join( dir, mac.name, `known_hosts` ) }`,
            `-o`, `StrictHostKeyChecking=accept-new`,
            `-o`, `ConnectTimeout=10`,
            `-o`, `PubkeyAuthentication=no`,
            `-o`, `PreferredAuthentications=password,keyboard-interactive`,
            `-o`, `NumberOfPasswordPrompts=1`,
            `${ mac.user }@${ mac.host }`, remote,
        ], {
            encoding: `utf8`,
            env: { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: `force`, DISPLAY: process.env.DISPLAY || `:0` },
            input: ``,
            timeout: 30_000,
        } )

        return status === 0 ? null : ( stderr || `` ).trim().split( `\n` ).pop() || `ssh exited ${ status }`
    } finally {
        rmSync( helper, { recursive: true, force: true } )
    }

}

/**
 * Verify one Mac: SSH reachable, key installed (installing it with the stored
 * password when needed), Screen Sharing reachable.
 * @returns {Promise<boolean>} Whether SSH and Screen Sharing both work
 */
const check_mac = async ( dir, mac, print, ports ) => {

    const [ ssh_up, vnc_up ] = await Promise.all( [ ports( mac.host, 22 ), ports( mac.host, 5900 ) ] )
    let ssh_ok = false

    if( !ssh_up ) print( `${ mac.name }: ssh down (22). Turn on Remote Login: System Settings > General > Sharing` )
    else if( key_login_works( dir, mac ) ) ssh_ok = true
    else {
        const failure = install_key( dir, mac )
        ssh_ok = !failure && key_login_works( dir, mac )
        print( ssh_ok ? `${ mac.name }: ssh key installed` : `${ mac.name }: could not install the ssh key (${ failure || `key login still refused` })` )
    }

    if( !vnc_up ) print( `${ mac.name }: Screen Sharing down (5900). Turn it on: System Settings > General > Sharing` )
    if( ssh_ok && vnc_up ) print( `${ mac.name }: ok (ssh key, Screen Sharing port)` )

    return ssh_ok && vnc_up

}

/**
 * babysit mac add|list|check|forget
 * @param {Object} cmd - Parsed mac command
 * @param {Object} [deps] - Seams: dir, print, ports, read_password
 * @returns {Promise<number>} Exit code
 */
export const cmd_mac = async ( cmd, {
    dir = MACS_DIR,
    print = console.log,
    ports = reachable,
    read_password = null,
} = {} ) => {

    if( cmd.mac_verb === `add` ) {
        const password = cmd.password_env ? process.env[ cmd.password_env ]
            : cmd.password_stdin ? ( read_password || read_stdin )()
                : process.stdin.isTTY ? await ( read_password || prompt_password )()
                    : null
        if( !password ) throw new Error( `No password: use --password-stdin or --password-env VAR${ cmd.password_env ? ` (${ cmd.password_env } is empty)` : `` }` )

        const mac = add_mac( { name: cmd.mac_name, host: cmd.mac_host, user: cmd.user || userInfo().username, password }, dir )
        print( `Added ${ mac.name } (${ mac.user }@${ mac.host }). Secrets: ${ dir }/${ mac.name } (0700); sessions get them only with --mac or --devices.` )

        return await check_mac( dir, mac, print, ports ) ? 0 : 1
    }

    if( cmd.mac_verb === `forget` ) {
        print( forget_mac( cmd.mac_name, dir ) ? `Forgot ${ cmd.mac_name }.` : `No Mac named ${ cmd.mac_name }.` )
        return 0
    }

    const macs = list_macs( dir ).filter( mac => !cmd.mac_name || mac.name === cmd.mac_name )
    if( !macs.length ) {
        print( cmd.mac_name ? `No Mac named ${ cmd.mac_name }.` : `No Macs. Add one with: babysit mac add NAME HOST --user USER --password-stdin` )
        return cmd.mac_name ? 1 : 0
    }

    if( cmd.mac_verb === `check` ) {
        const results = []
        for( const mac of macs ) results.push( await check_mac( dir, mac, print, ports ) )
        return results.every( Boolean ) ? 0 : 1
    }

    for( const mac of macs ) {
        const [ ssh_up, vnc_up ] = await Promise.all( [ ports( mac.host, 22 ), ports( mac.host, 5900 ) ] )
        print( `${ mac.name }  ${ mac.user }@${ mac.host }  ssh:${ ssh_up ? `up` : `down` }  vnc:${ vnc_up ? `up` : `down` }` )
    }
    return 0

}
