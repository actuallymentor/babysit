#!/usr/bin/env node

// Host commands share the container's ~/.babysitrc setup (Pushover keys, API keys)
import './boot_babysitrc.js'

// JSON import attribute embeds at build time; runtime fs reads resolve to /$bunfs in compiled binaries
import pkg from '../package.json' with { type: 'json' }

import { statSync } from 'fs'

import { log } from './utils/log.js'
import { parse_args } from './cli/parse.js'
import { show_help } from './cli/help.js'
import { wants_help } from './cli/help_topics.js'
import { launch_from_menu } from './cli/launcher.js'
import { cmd_launch_dir } from './cli/compose.js'
import { save_launch_defaults } from './babysit/launch_defaults.js'
import { cmd_start } from './cli/start.js'
import { cmd_list } from './cli/list.js'
import { cmd_watch } from './cli/watch.js'
import { cmd_fork } from './cli/fork.js'
import { cmd_init } from './cli/init.js'
import { cmd_audit } from './cli/audit.js'
import { cmd_clean } from './cli/clean.js'
import { cmd_archive } from './cli/archive.js'
import { cmd_open } from './cli/open.js'
import { cmd_resume, is_resume_listing } from './cli/resume.js'
import { cmd_recover, cmd_close, cmd_recovery_shutdown } from './cli/recover.js'
import { cmd_restart } from './cli/restart.js'
import { cmd_recover_init } from './cli/recover_init.js'
import { cmd_monitor } from './cli/monitor.js'
import { cmd_update } from './cli/update.js'
import { cmd_config } from './cli/config.js'
import { cmd_doctor } from './cli/doctor.js'
import { cmd_auth } from './cli/auth.js'
import { cmd_prune } from './cli/prune.js'
import { cmd_web } from './cli/web.js'
import { check_dependencies } from './deps/check.js'
import { time_phase_sync } from './utils/timing.js'
import { run_effort, run_model, run_exit, run_stuck, run_loop } from './docker/assets/effort/command.mjs'
import { run_usage } from './cli/usage.js'
import { cmd_shell_init } from './cli/shell_init.js'

const is_directory = path => {
    try {
        return statSync( path ).isDirectory()
    } catch {
        return false
    }
}

// Subcommands that need a dep check before they run. `help` and `--version`
// are pure metadata reads, `__monitor` is a background daemon that inherits
// the foreground's already-checked environment, and `update` runs its own
// dep check inside `cmd_update`.
const DEP_CHECK_VERBS = new Set( [ `start`, `launch_dir`, `resume`, `fork`, `list`, `watch`, `open`, `doctor`, `auth` ] )

/**
 * Main entry point
 */
const main = async () => {

    // `<command> [sub] --help` and `help <command>` print that command's page
    // before any command-specific parsing can reject or run it
    if( wants_help( process.argv.slice( 2 ) ) ) {
        show_help( process.argv.slice( 2 ) )
        return
    }

    // Keep the container helper and full CLI's effort syntax identical.
    if( process.argv[2] === `effort` ) {
        console.log( await run_effort( process.argv.slice( 3 ) ) )
        return
    }
    if( process.argv[2] === `model` ) {
        console.log( await run_model( process.argv.slice( 3 ) ) )
        return
    }
    if( process.argv[2] === `exit` ) {
        console.log( await run_exit( process.argv.slice( 3 ) ) )
        return
    }
    if( process.argv[2] === `stuck` ) {
        console.log( await run_stuck( process.argv.slice( 3 ) ) )
        return
    }
    if( process.argv[2] === `loop` ) {
        console.log( await run_loop( process.argv.slice( 3 ) ) )
        return
    }
    if( process.argv[2] === `usage` ) {
        process.exitCode = await run_usage( process.argv.slice( 3 ) )
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

    // `--config DIR/` starts every yaml in DIR; launch flags live in the files.
    // `babysit audit --config DIR/` reads the same files without starting anything.
    if( cmd.verb !== `audit` && cmd.verb !== `clean` && cmd.flags.config && is_directory( cmd.flags.config ) ) {
        if( cmd.verb !== `launch` || cmd.flags.name || cmd.flags.ports?.length || typeof cmd.flags.log === `string` ) {
            throw new Error( `babysit --config DIR/ takes no agent, name, or flags besides --yes; declare them in each yaml's launch: section` )
        }
        cmd = { ...cmd, verb: `launch_dir` }
    }

    if( cmd.verb === `launch` ) {
        cmd = await launch_from_menu( { name: cmd.flags.name || ``, config: cmd.flags.config, flags: cmd.flags } )
        if( !cmd ) return
        try {
            // A fork's toggles come from its parent; they are no launch default
            if( cmd.verb !== `fork` ) save_launch_defaults( cmd )
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

    case `launch_dir`:
        await cmd_launch_dir( cmd )
        break

    case `recover`:
        if( cmd.recover_verb === `init` ) await cmd_recover_init( cmd )
        else if( cmd.flags.shutdown ) await cmd_recovery_shutdown()
        else await cmd_recover( cmd )
        break

    case `archive`:
        await cmd_archive( cmd )
        break

    case `close`:
        await cmd_close( cmd )
        break

    case `restart`:
        await cmd_restart( cmd )
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

    case `fork`:
        await cmd_fork( cmd )
        break

    case `watch`:
        await cmd_watch( cmd )
        break

    case `init`:
        await cmd_init( cmd )
        break

    case `audit`:
        process.exitCode = await cmd_audit( cmd )
        break

    case `clean`:
        process.exitCode = await cmd_clean( cmd )
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

    case `shell-init`:
        cmd_shell_init( cmd )
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

    case `auth`:
        process.exitCode = await cmd_auth( cmd )
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
