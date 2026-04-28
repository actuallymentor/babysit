#!/usr/bin/env node

import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import { log } from './utils/log.js'
import { parse_args } from './cli/parse.js'
import { show_help } from './cli/help.js'
import { cmd_start } from './cli/start.js'
import { cmd_list } from './cli/list.js'
import { cmd_open } from './cli/open.js'

// Read version from package.json
const __dirname = dirname( fileURLToPath( import.meta.url ) )
const pkg = JSON.parse( readFileSync( join( __dirname, `..`, `package.json` ), `utf-8` ) )

/**
 * Main entry point
 */
const main = async () => {

    const cmd = parse_args( process.argv.slice( 2 ) )

    // --version
    if( cmd.flags.version ) {
        console.log( `babysit v${ pkg.version }` )
        process.exit( 0 )
    }

    // --help or no command
    if( cmd.flags.help || cmd.verb === `help` ) {
        show_help()
        process.exit( 0 )
    }

    // Dispatch to subcommand
    switch ( cmd.verb ) {

    case `start`:
    case `resume`:
        await cmd_start( cmd )
        break

    case `list`:
        await cmd_list()
        break

    case `open`:
        await cmd_open( cmd )
        break

    default:
        show_help()
        break

    }

}

// Run
main().catch( e => {
    log.error( e.message )
    process.exit( 1 )
} )
