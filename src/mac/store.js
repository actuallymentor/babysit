import { execFileSync } from 'child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

import { BABYSIT_DIR } from '../utils/paths.js'
import { build_private_tmpfile } from '../utils/tmpfile.js'

// Remote Macs. The registry (macs.json) holds no secrets; each Mac's password
// and ssh key live in their own 0700 directory beside it. Nothing here is
// ever mounted or put in Docker metadata: a session started with --mac gets a
// one-shot private copy uploaded with `docker cp` (see setup_mac_credentials).

export const MACS_DIR = join( BABYSIT_DIR, `macs` )
export const MAC_BOOTSTRAP_PATH = `/tmp/.babysit-mac`

// A tmpfs in the container (see docker/run.js): secrets live in memory only
export const MAC_CONTAINER_DIR = `/home/node/.config/babysit-mac`

const NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/i

// Hostnames and IPv4/IPv6 literals; a leading dash would be read as an ssh option
const HOST = /^[a-z0-9][a-z0-9.:-]{0,252}$/i

// macOS short names
const USER = /^[a-z_][a-z0-9._-]{0,31}$/i

const registry_path = dir => join( dir, `macs.json` )

const write_private = ( path, content ) => {

    writeFileSync( path, content, { mode: 0o600 } )
    chmodSync( path, 0o600 )

}

const private_dir = path => {

    mkdirSync( path, { recursive: true, mode: 0o700 } )
    chmodSync( path, 0o700 )

}

/**
 * Registered Macs (non-secret fields only).
 * @param {string} [dir=MACS_DIR] - Store root
 * @returns {{ name: string, host: string, user: string }[]}
 */
export const list_macs = ( dir = MACS_DIR ) => {

    try {
        return JSON.parse( readFileSync( registry_path( dir ), `utf8` ) ).macs ?? []
    } catch {
        return []
    }

}

const save_macs = ( dir, macs ) => {

    // Same-directory rename keeps readers from ever seeing a half-written registry
    const tmp = `${ registry_path( dir ) }.${ process.pid }.tmp`
    write_private( tmp, JSON.stringify( { macs }, null, 2 ) )
    renameSync( tmp, registry_path( dir ) )

}

/**
 * Record a Mac: registry entry, password, and a fresh ed25519 key pair.
 * Re-adding a name replaces its password and keeps its key.
 * @param {Object} mac
 * @param {string} mac.name - Label agents use
 * @param {string} mac.host - IP or hostname on the LAN
 * @param {string} mac.user - macOS account to log in as
 * @param {string} mac.password - Account password (Screen Sharing and sudo)
 * @param {string} [dir=MACS_DIR] - Store root
 * @returns {{ name: string, host: string, user: string }}
 */
export const add_mac = ( { name, host, user, password }, dir = MACS_DIR ) => {

    if( !NAME.test( name || `` ) ) throw new Error( `Mac name must be 1-32 letters, digits, dots, dashes or underscores` )
    if( !HOST.test( host || `` ) ) throw new Error( `Invalid Mac host: ${ host }` )
    if( !USER.test( user || `` ) ) throw new Error( `Invalid Mac user: ${ user }` )
    if( !password || /[\n\0]/.test( password ) ) throw new Error( `The password is empty or contains a newline` )

    private_dir( dir )
    private_dir( join( dir, name ) )
    write_private( join( dir, name, `password` ), password )

    const key = join( dir, name, `id_ed25519` )
    if( !existsSync( key ) ) {
        execFileSync( `ssh-keygen`, [ `-q`, `-t`, `ed25519`, `-N`, ``, `-C`, `babysit-mac-${ name }`, `-f`, key ], { stdio: `ignore` } )
    }

    // Re-adding keeps a Mac's enabled state, so a password change never re-exposes a disabled Mac
    const previous = list_macs( dir ).find( mac => mac.name === name )
    const entry = { name, host, user, ...previous?.enabled === false && { enabled: false } }
    save_macs( dir, [ ...list_macs( dir ).filter( mac => mac.name !== name ), entry ] )

    return entry

}

/**
 * Choose whether sessions receive a Mac's secrets. A disabled Mac stays
 * registered but never leaves the host. The choice is host-side on purpose:
 * resume, fork and restart rebuild a session from its stored modifiers, so a
 * per-launch list would silently widen back to every Mac.
 * @param {string} name - Registered name
 * @param {boolean} enabled - Whether sessions receive it
 * @param {string} [dir=MACS_DIR] - Store root
 * @returns {boolean} Whether it was registered
 */
export const set_mac_enabled = ( name, enabled, dir = MACS_DIR ) => {

    const macs = list_macs( dir )
    if( !macs.some( mac => mac.name === name ) ) return false

    save_macs( dir, macs.map( ( { enabled: _previous, ...mac } ) => {
        if( mac.name !== name ) return _previous === false ? { ...mac, enabled: false } : mac
        return enabled ? mac : { ...mac, enabled: false }
    } ) )

    return true

}

/**
 * Forget a Mac and delete its secrets.
 * @param {string} name - Registered name
 * @param {string} [dir=MACS_DIR] - Store root
 * @returns {boolean} Whether it was registered
 */
export const forget_mac = ( name, dir = MACS_DIR ) => {

    const macs = list_macs( dir )
    if( !macs.some( mac => mac.name === name ) ) return false

    save_macs( dir, macs.filter( mac => mac.name !== name ) )
    // The name passed the NAME pattern when it was added, but never trust a registry file blindly
    if( NAME.test( name ) ) rmSync( join( dir, name ), { recursive: true, force: true } )

    return true

}

/**
 * Credential upload for a --mac session: a private 0700 copy of the registry
 * and every enabled Mac's secrets, uploaded into the stopped container and
 * installed by the entrypoint. Returns no mounts when nothing is enabled, so a
 * session without --mac (or without Macs) never carries a secret. The staging
 * directory is a registered ephemeral transport: a crash leaves it for the
 * stale-transport sweep instead of in /tmp forever.
 * @param {Object} [options]
 * @param {string} [options.dir=MACS_DIR] - Store root
 * @returns {Object[]} `copy` mounts for the launch plan
 */
export const setup_mac_credentials = ( { dir = MACS_DIR } = {} ) => {

    const macs = list_macs( dir )
        .filter( ( { name, enabled } ) => enabled !== false && NAME.test( name ) && existsSync( join( dir, name, `password` ) ) )
        .map( ( { name, host, user } ) => ( { name, host, user } ) )
    if( !macs.length ) return []

    const staged = build_private_tmpfile( `mac-creds`, `macs.json`, JSON.stringify( { macs }, null, 2 ) )
    if( !staged ) throw new Error( `Could not stage the Mac credentials privately` )

    for( const { name } of macs ) {
        const copy = join( staged.directory, name )
        cpSync( join( dir, name ), copy, { recursive: true } )
        chmodSync( copy, 0o700 )
        readdirSync( copy ).forEach( file => chmodSync( join( copy, file ), 0o600 ) )
    }

    // Trailing /. uploads the directory's contents at the target
    return [ { type: `copy`, source: `${ staged.directory }/.`, target: MAC_BOOTSTRAP_PATH, cleanup: staged.directory } ]

}
