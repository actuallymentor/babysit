#!/usr/bin/env node

// JSON import attribute embeds at build time; runtime fs reads resolve to /$bunfs in compiled binaries
import pkg from '../package.json' with { type: 'json' }

import { log } from './utils/log.js'
import { parse_args } from './cli/parse.js'
import { show_help } from './cli/help.js'
import { launch_menu } from './cli/launcher.js'
import { save_launch_defaults } from './babysit/launch_defaults.js'
import { cmd_start } from './cli/start.js'
import { cmd_list } from './cli/list.js'
import { cmd_open } from './cli/open.js'
import { cmd_resume, is_resume_listing } from './cli/resume.js'
import { cmd_monitor } from './cli/monitor.js'
import { cmd_update } from './cli/update.js'
import { cmd_config } from './cli/config.js'
import { cmd_doctor } from './cli/doctor.js'
import { cmd_prune } from './cli/prune.js'
import { cmd_web } from './cli/web.js'
import { check_dependencies } from './deps/check.js'
import { time_phase_sync } from './utils/timing.js'
import { run_effort } from './docker/assets/effort/command.mjs'

// Subcommands that need a dep check before they run. `help` and `--version`
// are pure metadata reads, `__monitor` is a background daemon that inherits
// the foreground's already-checked environment, and `update` runs its own
// dep check inside `cmd_update`.
const DEP_CHECK_VERBS = new Set( [ `start`, `resume`, `list`, `open`, `doctor` ] )

/**
 * Main entry point
 */
const main = async () => {

    // Keep the container helper and full CLI's effort syntax identical.
    if( process.argv[2] === `effort` ) {
        console.log( await run_effort( process.argv.slice( 3 ) ) )
        return
    }

    let cmd = parse_args( process.argv.slice( 2 ) )

    // --version
    if( cmd.flags.version ) {
        console.log( `babysit v${ pkg.version }` )
        process.exit( 0 )
    }

    // Explicit help
    if( cmd.flags.help || cmd.verb === `help` ) {
        show_help()
        process.exit( 0 )
    }

    if( cmd.verb === `launch` ) {
        cmd = await launch_menu( { name: cmd.flags.name || `` } )
        if( !cmd ) return
        try {
            save_launch_defaults( cmd )
        } catch ( error ) {
            log.warn( `Could not save launch defaults: ${ error.message }` )
        }
    }

    // Pre-flight: dep check only. Self-update is no longer implicit — users
    // run `babysit update` when they want to refresh the repo, docker image,
    // and host agent CLIs. Auto-pulling on every command was surprising and
    // slowed session start, especially on flaky networks.
    // Reading the durable session registry is a local filesystem operation.
    // Keep bare `babysit resume` useful even before Docker/tmux are installed;
    // selecting a session still performs the normal dependency preflight.
    if( DEP_CHECK_VERBS.has( cmd.verb ) && !is_resume_listing( cmd ) ) {
        if( !time_phase_sync( `dependencies`, check_dependencies ) ) {
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
        await cmd_list( cmd )
        break

    case `open`:
        await cmd_open( cmd )
        break

    case `update`:
        await cmd_update()
        break

    case `config`:
        await cmd_config( cmd )
        break

    case `prune`:
        await cmd_prune( cmd )
        break

    case `web`:
        await cmd_web( cmd )
        break

    case `doctor`:
        await cmd_doctor( cmd )
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
