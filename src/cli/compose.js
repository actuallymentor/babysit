import { readdirSync, statSync } from 'fs'
import { createInterface } from 'readline/promises'
import { join, relative } from 'path'

import { launch_flags, launch_to_command, read_launch_section, validate_launch } from '../babysit/launch_config.js'
import { list_stored_sessions, session_original_workspace } from '../sessions/store.js'
import { list_sessions } from '../tmux/session.js'
import { canonical_workspace, cmd_start, should_confirm_docker_restricted_mode } from './start.js'

/**
 * The yaml files a directory launch reads: `DIR/*.yaml|yml`, not recursive.
 * Shared with `babysit audit` so both see the same set.
 * @param {string} dir - Absolute directory
 * @returns {string[]} Sorted absolute paths
 */
export const launch_dir_files = dir => {

    // statSync follows symlinks, so linked configs count as files
    const is_file = path => {
        try {
            return statSync( path ).isFile()
        } catch {
            return false
        }
    }

    return readdirSync( dir )
        .filter( name => /\.ya?ml$/i.test( name ) )
        .map( name => join( dir, name ) )
        .filter( is_file )
        .sort()

}

/**
 * Session name a directory launch gives a yaml without `launch.name`: its path
 * relative to the directory, minus extension unless that leaves only digits
 * (reserved for `babysit open N`).
 * @param {string} file - Path relative to the directory
 * @returns {string}
 */
export const launch_name_for = file => {

    const stem = file.replace( /\.ya?ml$/i, `` )
    return /^\d+$/.test( stem ) ? file : stem

}

/**
 * Read every yaml in a directory (not recursive) into a launch plan.
 * Names default to launch_name_for the file.
 * @param {string} dir - Absolute directory
 * @returns {{ files: string[], entries: Object[], errors: string[] }} Yaml paths, one entry per valid file, and every problem found
 */
export const read_launch_dir = dir => {

    const files = launch_dir_files( dir )

    const entries = []
    const errors = []

    for( const path of files ) {

        const file = relative( dir, path )
        try {
            const { launch, errors: problems } = validate_launch( read_launch_section( path ), { strict: true } )
            if( problems.length ) {
                errors.push( ...problems.map( problem => `${ file }: ${ problem }` ) )
                continue
            }

            const cmd = launch_to_command( launch, { config_path: path, name: launch_name_for( file ) } )
            entries.push( { path, file, launch, cmd } )
        } catch ( error ) {
            errors.push( `${ file }: ${ error.message }` )
        }

    }

    return { files, entries, errors }

}

/**
 * Pair each entry with the live session already started from its yaml.
 * @param {Object[]} entries - Launch plan
 * @param {Object[]} tmux_sessions - Live Babysit tmux sessions
 * @param {Object[]} stored_sessions - Durable session metadata
 * @returns {Object[]} Entries with `running` set to the live session record, or null
 */
export const match_running = ( entries, tmux_sessions, stored_sessions ) => {

    // Sessions without --config read their workspace's babysit.yaml
    const live = new Set( tmux_sessions.map( session => session.name ) )
    const config_of = session => session.config_path
        || session_original_workspace( session ) && join( session_original_workspace( session ), `babysit.yaml` )
    const running = stored_sessions
        .filter( session => live.has( session.tmux_session ) && config_of( session ) )
        .map( session => ( { session, config: canonical_workspace( config_of( session ) ) } ) )

    return entries.map( entry => ( {
        ...entry,
        running: running.find( ( { config } ) => config === canonical_workspace( entry.path ) )?.session || null,
    } ) )

}

/**
 * Render the overview printed before asking to start.
 * @param {Object[]} entries - Entries with `running`
 * @returns {string[]} Lines
 */
export const format_overview = entries => {

    const rows = entries.map( ( { file, launch, cmd, running } ) => [
        running ? `running` : `start`,
        file,
        cmd.flags.name,
        launch.agent,
        running ? `already ${ running.babysit_id }; skipped` : launch_flags( launch ).join( ` ` ) || `(no flags)`,
        ...launch.args.length ? [ `-- ${ launch.args.join( ` ` ) }` ] : [],
    ] )
    const widths = [ 0, 1, 2, 3 ].map( column => Math.max( ...rows.map( row => Array.from( row[ column ] ).length ) ) )
    const pad = ( text, column ) => text + ` `.repeat( widths[ column ] - Array.from( text ).length )

    // The restricted-Docker warning is normally its own prompt; say it here instead.
    const warnings = entries
        .filter( ( { running, cmd } ) => !running && should_confirm_docker_restricted_mode( cmd.flags ) )
        .map( ( { file } ) => `  ! ${ file }: --docker mounts the host Docker socket, so its sandbox/mudbox is not isolated from host writes.` )

    return [
        ...rows.map( row => `  ${ row.map( ( text, column ) => column < 4 ? pad( text, column ) : text ).join( `  ` ) }` ),
        ...warnings,
    ]

}

const ask_yes_no = async question => {

    const prompt = createInterface( { input: process.stdin, output: process.stdout } )
    try {
        return /^y(es)?$/i.test( ( await prompt.question( question ) ).trim() )
    } finally {
        prompt.close()
    }

}

/**
 * `babysit --config DIR/`: start one detached session per yaml in DIR, compose
 * style. Every file must declare a complete `launch:` section; files whose
 * session is still running are skipped, never started twice.
 * @param {Object} cmd - Parsed launch command; `flags.config` is the directory
 * @param {Object} [deps] - Injectable seams
 */
export const cmd_launch_dir = async ( cmd, {
    start = cmd_start,
    // Strict: a failed lookup must abort, not read as "nothing running"
    tmux_sessions = () => list_sessions( { strict: true } ),
    stored_sessions = list_stored_sessions,
    ask = ask_yes_no,
    interactive = process.stdin.isTTY && process.stdout.isTTY,
    print = console.log,
} = {} ) => {

    const dir = cmd.flags.config
    const { files, entries, errors } = read_launch_dir( dir )

    if( !files.length ) throw new Error( `No .yaml or .yml files in ${ dir }` )
    // Like compose, one broken file stops the whole launch before anything starts.
    if( errors.length ) throw new Error( `Invalid launch config in ${ dir }:\n${ errors.map( error => `  ${ error }` ).join( `\n` ) }` )

    const plan = match_running( entries, await tmux_sessions(), stored_sessions() )
    const pending = plan.filter( entry => !entry.running )

    print( `Sessions from ${ dir } (workspace ${ process.cwd() }):\n` )
    print( format_overview( plan ).join( `\n` ) )
    print( `` )

    if( !pending.length ) return print( `Every session is already running.` )

    const count = `${ pending.length } session${ pending.length === 1 ? `` : `s` }`
    if( !cmd.flags.yes ) {
        if( !interactive ) throw new Error( `Cannot confirm on a non-interactive terminal; pass --yes to start ${ count }.` )
        if( !await ask( `Start ${ count }? [y/N] ` ) ) return print( `Nothing started.` )
    }

    // One at a time: launches share auth leases, credential sync and the Docker
    // daemon. A failure skips that session only. Prompts were answered above.
    // cmd_start chdirs into its workspace (a clone, for clone: true), so every
    // start is pinned back to the directory the user ran from.
    const workspace = process.cwd()
    const started = []
    const failed = []
    for( const entry of pending ) {
        const { file, cmd: launch } = entry
        try {
            // Re-check right before starting: another terminal may have started it during the prompt
            const [ { running } ] = match_running( [ entry ], await tmux_sessions(), stored_sessions() )
            if( running ) {
                print( `Skipped ${ file }: already running as ${ running.babysit_id }` )
                continue
            }
            process.chdir( workspace )
            const session = await start( { ...launch, detached: true, batch: true, flags: { ...launch.flags, yes: true } } )
            started.push( { file, id: session?.babysit_id } )
        } catch ( error ) {
            failed.push( file )
            print( `Failed ${ file }: ${ error.message }` )
        }
    }
    process.chdir( workspace )

    print( `` )
    started.forEach( ( { file, id } ) => print( `Started ${ file }: babysit open ${ id }` ) )
    if( failed.length ) throw new Error( `${ failed.length } of ${ pending.length } sessions did not start: ${ failed.join( `, ` ) }` )

}
