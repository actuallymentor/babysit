import { execFileSync } from 'child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { BABYSIT_DIR } from '../utils/paths.js'
import { build_private_tmpfile } from '../utils/tmpfile.js'

// Remote machines (Macs, Windows PCs). The registry holds no secrets; each
// machine's password and ssh key live in their own 0700 directory beside it.
// Nothing here is ever mounted or put in Docker metadata: a session started
// with --mac / --windows gets a one-shot private copy uploaded with
// `docker cp` (see setup_remote_credentials).

/**
 * One profile per remote kind. Names match DEVICE_KINDS. `registry`/`key`
 * name the JSON file and its list; the in-container command reads the same
 * pair (src/docker/assets/remote/command.mjs keeps its own copy).
 */
export const REMOTE_KINDS = {
    mac: {
        name: `mac`, label: `Mac`, plural: `Macs`, os_user: `macOS account`,
        dir: join( BABYSIT_DIR, `macs` ), registry: `macs.json`, key: `macs`,
        bootstrap: `/tmp/.babysit-mac`,
        // A tmpfs in the container (see docker/run.js): secrets live in memory only
        container_dir: `/home/node/.config/babysit-mac`,
    },
    windows: {
        name: `windows`, label: `Windows PC`, plural: `Windows PCs`, os_user: `Windows account`,
        dir: join( BABYSIT_DIR, `windows` ), registry: `windows.json`, key: `machines`,
        bootstrap: `/tmp/.babysit-windows`,
        container_dir: `/home/node/.config/babysit-windows`,
    },
}

const MAC = REMOTE_KINDS.mac

// Kept for callers that only know Macs
export const MACS_DIR = MAC.dir
export const MAC_BOOTSTRAP_PATH = MAC.bootstrap
export const MAC_CONTAINER_DIR = MAC.container_dir

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i

// Hostnames and IPv4/IPv6 literals; a leading dash would be read as an ssh option
const HOST = /^[a-z0-9][a-z0-9.:-]{0,252}$/i

// macOS short names and Windows local account names (no spaces: ssh-safe)
const USER = /^[a-z_][a-z0-9._-]{0,31}$/i

const registry_path = ( kind, dir ) => join( dir, kind.registry )

const write_private = ( path, content ) => {

    writeFileSync( path, content, { mode: 0o600 } )
    chmodSync( path, 0o600 )

}

const private_dir = path => {

    mkdirSync( path, { recursive: true, mode: 0o700 } )
    chmodSync( path, 0o700 )

}

/**
 * Registered machines (non-secret fields only).
 * @param {Object} kind - A REMOTE_KINDS profile
 * @param {string} [dir=kind.dir] - Store root
 * @returns {{ name: string, host: string, user: string, enabled?: false }[]}
 */
export const list_remotes = ( kind, dir = kind.dir ) => {

    try {
        return JSON.parse( readFileSync( registry_path( kind, dir ), `utf8` ) )[ kind.key ] ?? []
    } catch {
        return []
    }

}

const save_remotes = ( kind, dir, machines ) => {

    // Same-directory rename keeps readers from ever seeing a half-written registry
    const tmp = `${ registry_path( kind, dir ) }.${ process.pid }.tmp`
    write_private( tmp, JSON.stringify( { [ kind.key ]: machines }, null, 2 ) )
    renameSync( tmp, registry_path( kind, dir ) )

}

/**
 * Record a machine: registry entry, password, and a fresh ed25519 key pair.
 * Re-adding a name replaces its password and keeps its key.
 * @param {Object} kind - A REMOTE_KINDS profile
 * @param {Object} machine
 * @param {string} machine.name - Label agents use
 * @param {string} machine.host - IP or hostname on the LAN
 * @param {string} machine.user - Account to log in as
 * @param {string} machine.password - Account password (VNC, sudo, unlock)
 * @param {string} [dir=kind.dir] - Store root
 * @returns {{ name: string, host: string, user: string }}
 */
export const add_remote = ( kind, { name, host, user, password }, dir = kind.dir ) => {

    if( !NAME.test( name || `` ) ) throw new Error( `${ kind.label } name must be 1-32 letters, digits, dots, dashes or underscores` )
    if( !HOST.test( host || `` ) ) throw new Error( `Invalid ${ kind.label } host: ${ host }` )
    if( !USER.test( user || `` ) ) throw new Error( `Invalid ${ kind.label } user: ${ user }` )
    if( !password || /[\n\0]/.test( password ) ) throw new Error( `The password is empty or contains a newline` )

    private_dir( dir )
    private_dir( join( dir, name ) )
    write_private( join( dir, name, `password` ), password )

    const key = join( dir, name, `id_ed25519` )
    if( !existsSync( key ) ) {
        execFileSync( `ssh-keygen`, [ `-q`, `-t`, `ed25519`, `-N`, ``, `-C`, `babysit-${ kind.name }-${ name }`, `-f`, key ], { stdio: `ignore` } )
    }

    // Re-adding keeps the enabled state, so a password change never re-exposes a disabled machine
    const previous = list_remotes( kind, dir ).find( machine => machine.name === name )
    const entry = { name, host, user, ...previous?.enabled === false && { enabled: false } }
    save_remotes( kind, dir, [ ...list_remotes( kind, dir ).filter( machine => machine.name !== name ), entry ] )

    return entry

}

/**
 * Choose whether sessions receive a machine's secrets. A disabled machine
 * stays registered but never leaves the host. The choice is host-side on
 * purpose: resume, fork and restart rebuild a session from its stored
 * modifiers, so a per-launch list would silently widen back to every machine.
 * @returns {boolean} Whether it was registered
 */
export const set_remote_enabled = ( kind, name, enabled, dir = kind.dir ) => {

    const machines = list_remotes( kind, dir )
    if( !machines.some( machine => machine.name === name ) ) return false

    save_remotes( kind, dir, machines.map( ( { enabled: _previous, ...machine } ) => {
        if( machine.name !== name ) return _previous === false ? { ...machine, enabled: false } : machine
        return enabled ? machine : { ...machine, enabled: false }
    } ) )

    return true

}

/**
 * Forget a machine and delete its secrets.
 * @returns {boolean} Whether it was registered
 */
export const forget_remote = ( kind, name, dir = kind.dir ) => {

    const machines = list_remotes( kind, dir )
    if( !machines.some( machine => machine.name === name ) ) return false

    save_remotes( kind, dir, machines.filter( machine => machine.name !== name ) )
    // The name passed the NAME pattern when it was added, but never trust a registry file blindly
    if( NAME.test( name ) ) rmSync( join( dir, name ), { recursive: true, force: true } )

    return true

}

/**
 * Credential upload for a --mac / --windows session: a private 0700 copy of
 * the registry and every enabled machine's secrets, uploaded into the stopped
 * container and installed by the entrypoint. Returns no mounts when nothing
 * is enabled, so a session without the kind never carries a secret. The
 * staging directory is a registered ephemeral transport: a crash leaves it
 * for the stale-transport sweep instead of in /tmp forever.
 * @param {Object} kind - A REMOTE_KINDS profile
 * @param {Object} [options]
 * @param {string} [options.dir=kind.dir] - Store root
 * @returns {Object[]} `copy` mounts for the launch plan
 */
export const setup_remote_credentials = ( kind, { dir = kind.dir } = {} ) => {

    const machines = list_remotes( kind, dir )
        .filter( ( { name, enabled } ) => enabled !== false && NAME.test( name ) && existsSync( join( dir, name, `password` ) ) )
        .map( ( { name, host, user } ) => ( { name, host, user } ) )
    if( !machines.length ) return []

    const staged = build_private_tmpfile( `${ kind.name }-creds`, kind.registry, JSON.stringify( { [ kind.key ]: machines }, null, 2 ) )
    if( !staged ) throw new Error( `Could not stage the ${ kind.label } credentials privately` )

    for( const { name } of machines ) {
        const copy = join( staged.directory, name )
        cpSync( join( dir, name ), copy, { recursive: true } )
        chmodSync( copy, 0o700 )
        readdirSync( copy ).forEach( file => chmodSync( join( copy, file ), 0o600 ) )
    }

    // Trailing /. uploads the directory's contents at the target
    return [ { type: `copy`, source: `${ staged.directory }/.`, target: kind.bootstrap, cleanup: staged.directory } ]

}

// ---------------------------------------------------------------------------
// Mac shorthands (the original API)

export const list_macs = ( dir ) => list_remotes( MAC, dir )
export const add_mac = ( machine, dir ) => add_remote( MAC, machine, dir )
export const set_mac_enabled = ( name, enabled, dir ) => set_remote_enabled( MAC, name, enabled, dir )
export const forget_mac = ( name, dir ) => forget_remote( MAC, name, dir )
export const setup_mac_credentials = options => setup_remote_credentials( MAC, options )
