import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

// Base directories
const home = homedir()

export const BABYSIT_DIR = join( home, `.babysit` )
export const SESSIONS_DIR = join( BABYSIT_DIR, `sessions` )
export const AGENTS_DIR = join( home, `.agents` )
export const TMUX_SOCKET = `babysit`

/**
 * Ensure the babysit config directories exist
 */
export const ensure_dirs = () => {

    mkdirSync( SESSIONS_DIR, { recursive: true } )

}
