import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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
