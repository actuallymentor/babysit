#!/usr/bin/env node

// JSON import attribute embeds at build time; runtime fs reads resolve to /$bunfs in compiled binaries
import pkg from '../package.json' with { type: 'json' }

import { log } from './utils/log.js'
import { parse_args } from './cli/parse.js'
import { show_help } from './cli/help.js'
import { cmd_start } from './cli/start.js'
import { cmd_list } from './cli/list.js'
import { cmd_open } from './cli/open.js'
import { cmd_resume } from './cli/resume.js'
import { cmd_monitor } from './cli/monitor.js'
import { cmd_update } from './cli/update.js'
import { check_dependencies } from './deps/check.js'

// Subcommands that need a dep check before they run. `help` and `--version`
// are pure metadata reads, `__monitor` is a background daemon that inherits
// the foreground's already-checked environment, and `update` runs its own
// dep check inside `cmd_update`.
const DEP_CHECK_VERBS = new Set( [ `start`, `resume`, `list`, `open` ] )

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

    // Pre-flight: dep check only. Self-update is no longer implicit — users
    // run `babysit update` when they want to refresh the repo, docker image,
    // and host agent CLIs. Auto-pulling on every command was surprising and
    // slowed session start, especially on flaky networks.
    if( DEP_CHECK_VERBS.has( cmd.verb ) ) {
        if( !check_dependencies() ) {
            log.error( `Missing dependencies. Install them and try again.` )
            process.exit( 1 )
        }
    }

    // Dispatch to subcommand
    switch ( cmd.verb ) {

    case `start`:
        await cmd_start( cmd )
        break

    case `resume`:
        // `babysit <agent> resume <id>` arrives with agent set — go to cmd_start
        // `babysit resume <id>` arrives with agent: null — needs cmd_resume to look up the stored session
        if( cmd.agent ) await cmd_start( cmd )
        else await cmd_resume( cmd )
        break

    case `list`:
        await cmd_list()
        break

    case `open`:
        await cmd_open( cmd )
        break

    case `update`:
        await cmd_update()
        break

    case `__monitor`:
        await cmd_monitor( cmd )
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
