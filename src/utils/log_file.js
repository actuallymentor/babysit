import { homedir } from 'os'
import { join, dirname, isAbsolute } from 'path'
import { mkdirSync, existsSync, appendFileSync } from 'fs'

import { log } from './log.js'

const pad = ( n ) => String( n ).padStart( 2, `0` )

/**
 * Build the default tmux log filename for a session that started at `now`.
 * Hidden file in cwd (leading dot) so the user's `ls` stays uncluttered.
 * @param {Date} [now]
 * @returns {string}
 */
export const default_log_name = ( now = new Date() ) => {

    const Y = now.getFullYear()
    const M = pad( now.getMonth() + 1 )
    const D = pad( now.getDate() )
    const h = pad( now.getHours() )
    const m = pad( now.getMinutes() )

    return `.${ Y }_${ M }_${ D }_${ h }_${ m }.babysit.log`

}

/**
 * Resolve a `--log` flag value into an absolute filesystem path.
 *
 * Empty / true / null → default `.YYYY_MM_DD_HH_MM.babysit.log` in cwd.
 * Leading `~/` → expanded against the host user's home dir.
 * Relative path → resolved against cwd.
 * Absolute path → returned as-is.
 *
 * @param {string|true|null} raw - The `--log` flag value as parsed
 * @param {Object} [opts]
 * @param {string} [opts.cwd]
 * @param {Date} [opts.now]
 * @returns {string} Absolute path
 */
export const resolve_log_path = ( raw, { cwd = process.cwd(), now = new Date() } = {} ) => {

    let path = ( typeof raw === `string` && raw.length > 0 ) ? raw : default_log_name( now )

    if( path === `~` ) path = homedir()
    else if( path.startsWith( `~/` ) ) path = join( homedir(), path.slice( 2 ) )

    if( !isAbsolute( path ) ) path = join( cwd, path )

    return path

}

/**
 * Format the per-session header line written at the top of each new session's
 * log block. Includes seconds — readers grep for these to navigate between
 * sessions appended to the same file.
 * @param {Date} [now]
 * @returns {string}
 */
export const format_session_header = ( now = new Date() ) => {

    const Y = now.getFullYear()
    const M = pad( now.getMonth() + 1 )
    const D = pad( now.getDate() )
    const h = pad( now.getHours() )
    const m = pad( now.getMinutes() )
    const s = pad( now.getSeconds() )

    return `Babysit session start: ${ Y }-${ M }-${ D } ${ h }:${ m }:${ s }`

}

/**
 * Open the log file (creating parent dirs as needed) and append the session
 * header. The blank line in front separates this block from the previous
 * session's tail, so `grep ^Babysit\\ session\\ start log` shows clean section
 * boundaries.
 *
 * @param {string} log_path - Absolute path to the log file
 * @param {Date} [now]
 * @returns {boolean} True on success, false on filesystem error
 */
export const append_session_header = ( log_path, now = new Date() ) => {

    try {

        const parent = dirname( log_path )
        if( !existsSync( parent ) ) mkdirSync( parent, { recursive: true } )

        const header = format_session_header( now )
        const block = existsSync( log_path ) ? `\n${ header }\n` : `${ header }\n`
        appendFileSync( log_path, block )

        return true

    } catch ( e ) {
        log.warn( `Could not write log header to ${ log_path }: ${ e.message }` )
        return false
    }

}
