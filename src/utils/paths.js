import { isAbsolute, join, normalize } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

/**
 * Resolve host state independently of the working directory, including at boot.
 * @param {string} [home] - Account home used for the default
 * @param {string} [value] - BABYSIT_HOME override; empty uses the default
 * @returns {string} Absolute state directory
 */
export const resolve_babysit_home = ( home = homedir(), value = process.env.BABYSIT_HOME ) => {

    if( !value ) return join( home, `.babysit` )
    if( !isAbsolute( value ) || /[\x00-\x1f\x7f]/.test( value ) ) {
        throw new Error( `BABYSIT_HOME must be an absolute path without control characters` )
    }

    return normalize( value )

}

// Base directories
const home = homedir()

export const BABYSIT_DIR = resolve_babysit_home()
export const SESSIONS_DIR = join( BABYSIT_DIR, `sessions` )
export const CLONES_DIR = join( BABYSIT_DIR, `clones` )
export const CREDENTIAL_RECOVERY_DIR = join( BABYSIT_DIR, `credential-recovery` )
export const AGENTS_DIR = join( home, `.agents` )
export const TMUX_SOCKET = process.env.BABYSIT_TMUX_SOCKET || `babysit`

/**
 * Ensure the babysit config directories exist
 */
export const ensure_dirs = () => {

    mkdirSync( SESSIONS_DIR, { recursive: true } )

}
