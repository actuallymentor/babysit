import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { log } from './log.js'

// Set once loaded so child babysit processes (monitor, probes) skip re-sourcing
export const BABYSITRC_LOADED_ENV = `BABYSIT_RC_LOADED`

// `set -a` exports plain KEY=value lines, matching the container entrypoint.
// The rc's own output is discarded; only the resulting environment is read.
const SOURCE_SCRIPT = `set -a; source "$1" >/dev/null 2>&1 </dev/null; env -0`

// Bash bookkeeping, not rc setup
const SHELL_NOISE = new Set( [ `_`, `SHLVL`, `PWD`, `OLDPWD` ] )

/**
 * Source ~/.babysitrc in bash and merge the resulting variables into env, so
 * host commands (the auth timer included) see the same setup as containers.
 * Never throws: a broken rc warns and leaves the environment untouched.
 * @param {Object} [options] - Environment, rc path and exec seams
 * @returns {string[]} Keys that were added or changed
 */
export const load_babysitrc = ( { env = process.env, path = join( homedir(), `.babysitrc` ), exec = execFileSync } = {} ) => {

    if( env[ BABYSITRC_LOADED_ENV ] || !existsSync( path ) ) return []
    env[ BABYSITRC_LOADED_ENV ] = `1`

    try {

        const output = exec( `bash`, [ `-c`, SOURCE_SCRIPT, `babysitrc`, path ], {
            env, encoding: `utf8`, timeout: 5_000, stdio: [ `ignore`, `pipe`, `ignore` ],
        } )

        const changed = []
        for( const entry of output.split( `\0` ) ) {
            const split = entry.indexOf( `=` )
            if( split < 1 ) continue

            const [ key, value ] = [ entry.slice( 0, split ), entry.slice( split + 1 ) ]
            if( SHELL_NOISE.has( key ) || env[ key ] === value ) continue
            env[ key ] = value
            changed.push( key )
        }
        return changed

    } catch ( error ) {
        log.warn( `Could not source ${ path }: ${ error.message }` )
        return []
    }

}

// Plain or exported assignment; the value is never read
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/
// A commented-out assignment is dead config, never a title (it may hold a secret)
const COMMENTED_ASSIGNMENT = /^\s*#[#\s]*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/
const DEFAULT_LINE = /^\s*#[#\s]*default:\s*(true|false)\s*$/i
const COMMENT = /^\s*#[#\s]*(.*?)\s*$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Group ~/.babysitrc variables under their comment headers. A comment after
 * an assignment opens a group; its first line is the title and a
 * `# default: false` line keeps its variables out unless picked. Variables
 * above the first comment form an untitled group. Values are never read.
 * @param {Object} [options] - rc path and read seam
 * @returns {Array<{ title: string|null, default: boolean, keys: string[] }>}
 */
export const read_babysitrc_groups = ( {
    path = join( homedir(), `.babysitrc` ),
    read = file => existsSync( file ) ? readFileSync( file, `utf8` ) : ``,
} = {} ) => {

    const groups = []
    const seen = new Set()
    let group = null

    // A header line only opens a group once the previous one has variables
    const open = () => {
        if( !group || group.keys.length ) groups.push( group = { title: null, default: true, keys: [] } )
        return group
    }

    for( const line of read( path ).split( `\n` ) ) {

        if( line.startsWith( `#!` ) || COMMENTED_ASSIGNMENT.test( line ) ) continue

        const fallback = line.match( DEFAULT_LINE )
        if( fallback ) {
            open().default = fallback[ 1 ].toLowerCase() === `true`
            continue
        }

        const [ , comment ] = line.match( COMMENT ) || []
        if( comment !== undefined ) {
            const header = open()
            if( !header.title && comment ) header.title = comment
            continue
        }

        const key = line.match( ASSIGNMENT )?.[ 1 ]
        if( !key || seen.has( key ) ) continue
        seen.add( key )
        ;( group || open() ).keys.push( key )

    }

    return groups.filter( ( { keys } ) => keys.length )

}

/**
 * Variables the rc keeps out by default: those in `# default: false` groups.
 * @param {Array<Object>} groups - From read_babysitrc_groups
 * @returns {string[]} Excluded variable names
 */
export const default_env_exclude = groups => groups.filter( group => !group.default ).flatMap( ( { keys } ) => keys )

/**
 * Validate an --env-exclude value: comma or space separated names, repeatable.
 * @param {string|string[]|undefined} value - Raw flag value
 * @returns {string[]|null} Names, [] for an explicit empty list, null when absent
 */
export const normalise_env_exclude = value => {

    if( value === undefined || value === false ) return null
    const names = [ value ].flat().flatMap( item => String( item ).split( /[,\s]+/ ) ).filter( Boolean )
    const invalid = names.find( name => !ENV_NAME.test( name ) )
    if( invalid ) throw new Error( `--env-exclude takes variable names; "${ invalid }" is not one` )
    return [ ...new Set( names ) ]

}
