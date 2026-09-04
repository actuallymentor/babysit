import { createInterface } from 'readline/promises'
import { realpathSync } from 'fs'
import { resolve } from 'path'

import { clone_lock_status } from '../clone.js'
import {
    clone_directory_size,
    list_managed_clones,
    path_is_inside_clone,
    prune_managed_clone,
    recover_prune_operations,
} from '../prune.js'
import { inspect_docker_container_state } from '../docker/file_transport.js'
import { inspect_stored_sessions, update_session } from '../sessions/store.js'
import { list_sessions } from '../tmux/session.js'
import { CLONES_DIR, SESSIONS_DIR } from '../utils/paths.js'
import { is_monitor_alive } from './monitor_process.js'
import { format_table } from './list.js'

const DEFAULT_UNUSED_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1_000
const ACTIVE_CONTAINER_STATES = new Set( [ `created`, `running`, `paused`, `restarting` ] )

const canonical_path = path => {

    try {
        return realpathSync.native( path )
    } catch {
        return resolve( path )
    }

}

const parsed_time = value => {

    const milliseconds = Date.parse( value )
    return Number.isNaN( milliseconds ) ? null : milliseconds

}

const session_matches_clone = ( session, clone ) => {

    if( session.clone_id === clone.clone_id ) return true
    if( typeof session.clone_path === `string` && canonical_path( session.clone_path ) === clone.clone_path ) return true

    return session.babysit_id === clone.clone_id
        && ( session.clone || Array.isArray( session.modifiers ) && session.modifiers.includes( `clone` ) )

}

/**
 * Group stored launch records belonging to one durable clone.
 * @param {Object} clone - Managed clone metadata
 * @param {Array<{ session: Object }>} records - Stored session records
 * @returns {Array<{ session: Object, path: string, updated_at: string }>} Clone-family records
 */
export const clone_session_records = ( clone, records ) =>
    records.filter( ( { session } ) => session_matches_clone( session, clone ) )

/**
 * Resolve the latest trustworthy use time for a clone family.
 * Record mtime covers legacy long-running sessions whose launch timestamp is old.
 * @param {Object} clone - Managed clone metadata
 * @param {Array<{ session: Object, updated_at: string }>} records - Clone-family records
 * @returns {number|null} Epoch milliseconds, or null when no timestamp is usable
 */
export const clone_last_used_at = ( clone, records ) => {

    const timestamps = [
        clone.created_at,
        ...records.flatMap( ( { session, updated_at } ) => [
            session.last_used_at,
            session.ended_at,
            session.monitor_started_at,
            session.started_at,
            updated_at,
        ] ),
    ].map( parsed_time ).filter( Number.isFinite )

    return timestamps.length ? Math.max( ...timestamps ) : null

}

const inspect_clone_protection = async ( clone, family, {
    live_tmux_names,
    current_workspace,
    registry_error = null,
    tmux_error = null,
    inspect_container = inspect_docker_container_state,
    monitor_alive = is_monitor_alive,
    inspect_lock = true,
} ) => {

    if( current_workspace && path_is_inside_clone( clone.clone_path, current_workspace ) ) {
        return { active: false, reason: `protected: current directory` }
    }
    if( registry_error ) return { active: false, reason: `protected: ${ registry_error }` }
    if( tmux_error ) return { active: false, reason: `protected: tmux check failed` }

    if( family.some( ( { session } ) => live_tmux_names.has( session.tmux_session ) ) ) {
        return { active: true, reason: `active: tmux` }
    }

    if( family.some( ( { session } ) => monitor_alive( session.monitor_pid, session.monitor_token ) ) ) {
        return { active: true, reason: `active: monitor` }
    }

    if( inspect_lock ) {
        const lock = clone_lock_status( clone.clone_path )
        if( lock === `locked` ) return { active: true, reason: `active: launch` }
        if( lock === `unknown` ) return { active: false, reason: `protected: clone lock unreadable` }
    }

    const uncertain_sessions = family.filter( ( { session } ) =>
        [ `active`, `preparing` ].includes( session.status )
        || session.container_cleaned === false
        || session.credentials_cleaned === false
    )

    for( const { session } of uncertain_sessions ) {
        const container = session.container_id || session.container_name
        if( typeof container !== `string` || !container ) {
            return { active: false, reason: `protected: activity unknown` }
        }

        let state
        try {
            state = await inspect_container( container )
        } catch {
            return { active: false, reason: `protected: Docker check failed` }
        }

        if( ACTIVE_CONTAINER_STATES.has( state ) ) return { active: true, reason: `active: container` }
        if( state || session.credentials_cleaned === false ) {
            return { active: false, reason: `protected: recovery pending` }
        }
    }

    return { active: false, reason: null }

}

const inspect_clone_size = clone => {

    try {
        return { size_bytes: clone_directory_size( clone.clone_path ), size_error: null }
    } catch ( error ) {
        return { size_bytes: null, size_error: error }
    }

}

/**
 * Build the clone inventory used by both listing and destructive selection.
 * Liveness failures remain visible and make every affected clone ineligible.
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root
 * @param {string} [options.sessions_dir] - Session registry root
 * @param {Function} [options.list_tmux] - Strict tmux session reader
 * @param {Function} [options.inspect_container] - Docker state reader
 * @param {Function} [options.monitor_alive] - Monitor liveness reader
 * @param {Function} [options.get_cwd] - Current directory reader
 * @param {string[]} [options.clone_ids] - Optional clone ids for focused revalidation
 * @returns {Promise<Object>} Clone inventory and safety diagnostics
 */
export const inspect_clone_inventory = async ( {
    clones_dir = CLONES_DIR,
    sessions_dir = SESSIONS_DIR,
    list_tmux = () => list_sessions( { strict: true } ),
    inspect_container = inspect_docker_container_state,
    monitor_alive = is_monitor_alive,
    get_cwd = process.cwd,
    inspect_locks = true,
    clone_ids = null,
} = {} ) => {

    const managed = list_managed_clones( { clones_dir } )
    const stored = inspect_stored_sessions( { directory: sessions_dir } )
    let tmux_sessions = []
    let tmux_error = null

    try {
        tmux_sessions = await list_tmux()
    } catch ( error ) {
        tmux_error = error
    }

    const live_tmux_names = new Set( tmux_sessions.map( ( { name } ) => name ) )
    const stored_tmux_names = new Set( stored.records.map( ( { session } ) => session.tmux_session ).filter( Boolean ) )
    const unowned_tmux_sessions = tmux_sessions.filter( ( { name } ) => !stored_tmux_names.has( name ) )
    const registry_error = stored.invalid_files.length
        ? `session registry unreadable`
        : unowned_tmux_sessions.length
            ? `session ownership unknown`
            : null
    const current_workspace = canonical_path( get_cwd() )
    const selected_ids = clone_ids ? new Set( clone_ids ) : null
    const selected_clones = selected_ids
        ? managed.clones.filter( ( { clone_id } ) => selected_ids.has( clone_id ) )
        : managed.clones
    const clones = await Promise.all( selected_clones.map( async clone => {
        const records = clone_session_records( clone, stored.records )
        const last_used_at = clone_last_used_at( clone, records )
        const { size_bytes, size_error } = inspect_clone_size( clone )
        const protection = await inspect_clone_protection( clone, records, {
            live_tmux_names,
            current_workspace,
            registry_error,
            tmux_error,
            inspect_container,
            monitor_alive,
            inspect_lock: inspect_locks,
        } )
        const size_reason = size_error?.code === `BABYSIT_CLONE_CROSS_DEVICE`
            ? `protected: mounted filesystem`
            : size_error
                ? `protected: unreadable clone`
                : null
        const reason = protection.reason || size_reason
        const latest_record = records.reduce( ( latest, record ) => {
            if( !latest ) return record
            return parsed_time( record.updated_at ) > parsed_time( latest.updated_at ) ? record : latest
        }, null )

        return {
            ...clone,
            records,
            name: latest_record?.session.name || `-`,
            last_used_at,
            size_bytes,
            size_error,
            active: protection.active,
            available: !reason,
            status: reason || `available`,
        }
    } ) )

    return {
        ...managed,
        clones: clones.sort( ( a, b ) => ( a.last_used_at ?? Infinity ) - ( b.last_used_at ?? Infinity ) ),
        invalid_session_files: stored.invalid_files,
        unowned_tmux_sessions,
        tmux_error,
    }

}

/**
 * Select available clones under an age or all-unused policy.
 * @param {Object[]} clones - Annotated clone inventory
 * @param {{ mode: 'days'|'all', days?: number }} policy - Retention policy
 * @param {number} [now] - Current epoch milliseconds
 * @returns {Object[]} Eligible clones
 */
export const select_prune_candidates = ( clones, policy, now = Date.now() ) => {

    const available = clones.filter( clone => clone.available )
    if( policy.mode === `all` ) return available

    const cutoff = now - policy.days * DAY_MS
    return available.filter( clone => Number.isFinite( clone.last_used_at ) && clone.last_used_at <= cutoff )

}

/**
 * Parse a custom retention period.
 * @param {string} value - User input
 * @returns {number|null} Whole days, including zero, or null when invalid
 */
export const parse_prune_days = value => {

    const normalized = String( value ).trim()
    if( !/^\d+$/.test( normalized ) ) return null

    const days = Number( normalized )
    return Number.isSafeInteger( days ) ? days : null

}

const format_size = bytes => {

    if( !Number.isFinite( bytes ) ) return `unknown`
    if( bytes < 1_024 ) return `${ bytes } B`

    const units = [ `KiB`, `MiB`, `GiB`, `TiB` ]
    let value = bytes / 1_024
    let [ unit ] = units

    for( let index = 1; index < units.length && value >= 1_024; index++ ) {
        value /= 1_024
        unit = units[index]
    }

    return `${ value >= 10 ? value.toFixed( 0 ) : value.toFixed( 1 ) } ${ unit }`

}

const format_last_used = milliseconds => Number.isFinite( milliseconds )
    ? new Date( milliseconds ).toISOString().slice( 0, 10 )
    : `unknown`

const format_age = ( milliseconds, now ) => {

    if( !Number.isFinite( milliseconds ) ) return `unknown`
    return `${ Math.max( 0, Math.floor( ( now - milliseconds ) / DAY_MS ) ) }d`

}

const write_line = ( output, value = `` ) => output.write( `${ value }\n` )

const print_inventory_summary = ( inventory, output ) => {

    const active = inventory.clones.filter( clone => clone.active ).length
    const protected_count = inventory.clones.filter( clone => !clone.active && !clone.available ).length
    const noun = inventory.clones.length === 1 ? `clone` : `clones`
    write_line( output, `${ inventory.clones.length } ${ noun } currently in ${ inventory.clone_root } (${ active } active, ${ protected_count } protected).` )

    if( inventory.ignored_entries.length || inventory.invalid_manifests.length ) {
        write_line( output, `${ inventory.ignored_entries.length + inventory.invalid_manifests.length } unrecognized clone entries were ignored.` )
    }
    if( inventory.pending_prunes.length ) {
        write_line( output, `${ inventory.pending_prunes.length } interrupted prune operations remain in quarantine.` )
    }

}

const print_clone_table = ( clones, output, now = Date.now() ) => {

    if( !clones.length ) return

    const table = format_table(
        [ `NAME`, `CLONE ID`, `LAST USED`, `AGE`, `STATUS`, `SIZE`, `DIRECTORY` ],
        clones.map( clone => [
            clone.name,
            clone.clone_id,
            format_last_used( clone.last_used_at ),
            format_age( clone.last_used_at, now ),
            clone.status,
            format_size( clone.size_bytes ),
            clone.clone_path,
        ] )
    )

    write_line( output )
    write_line( output, `  ${ table.header }` )
    write_line( output, `  ${ table.divider }` )
    table.rows.forEach( row => write_line( output, `  ${ row }` ) )
    write_line( output )

}

const choose_policy = async ( question, output ) => {

    write_line( output )
    write_line( output, `Which clone copies should be pruned?` )
    write_line( output, `  1. Unused for 30 days (default)` )
    write_line( output, `  2. All not in use` )
    write_line( output, `  3. Custom amount of days` )

    while( true ) {
        const choice = ( await question( `Choose [1]: ` ) ).trim() || `1`
        if( choice === `1` ) return { mode: `days`, days: DEFAULT_UNUSED_DAYS }
        if( choice === `2` ) return { mode: `all` }
        if( choice !== `3` ) {
            write_line( output, `Choose 1, 2, or 3.` )
            continue
        }

        while( true ) {
            const days = parse_prune_days( await question( `Unused for how many days? (0 means all not in use): ` ) )
            if( days === 0 ) return { mode: `all` }
            if( days !== null ) return { mode: `days`, days }
            write_line( output, `Enter a whole number of days, zero or greater.` )
        }
    }

}

const session_marker = sessions_dir => async ( session_ids, pruned_at ) => {

    session_ids.forEach( babysit_id => update_session( babysit_id, {
        clone_pruned_at: pruned_at,
        monitor_pid: null,
        status: `pruned`,
    }, { directory: sessions_dir } ) )

}

/**
 * List clone usage or interactively prune unused managed workspaces.
 * @param {Object} cmd - Parsed prune command
 * @param {Object} [dependencies]
 * @param {NodeJS.ReadableStream} [dependencies.input] - Interactive input
 * @param {NodeJS.WritableStream} [dependencies.output] - Command output
 * @param {string} [dependencies.clones_dir] - Clone root
 * @param {string} [dependencies.sessions_dir] - Session registry root
 * @param {Function} [dependencies.inspect_inventory] - Inventory loader
 * @param {Function} [dependencies.prune_clone] - Managed deletion function
 * @param {Function} [dependencies.recover_prunes] - Interrupted prune recovery
 * @param {Function} [dependencies.ask] - Prompt reader, injectable for tests
 * @param {Function} [dependencies.now] - Epoch millisecond reader
 * @returns {Promise<void>}
 */
export const cmd_prune = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    clones_dir = CLONES_DIR,
    sessions_dir = SESSIONS_DIR,
    inspect_inventory = options => inspect_clone_inventory( options ),
    prune_clone = prune_managed_clone,
    recover_prunes = recover_prune_operations,
    ask = null,
    now = Date.now,
} = {} ) => {

    if( !cmd.flags.list && !input.isTTY ) {
        throw new Error( `babysit prune requires an interactive terminal; use babysit prune --list to inspect clones.` )
    }

    const inventory_options = { clones_dir, sessions_dir }
    const mark_sessions = session_marker( sessions_dir )
    if( !cmd.flags.list ) {
        const recovery = await recover_prunes( { clones_dir, mark_sessions } )
        recovery.recovered.forEach( clone_id => write_line( output, `Finished interrupted prune: ${ clone_id }` ) )
        recovery.failed.forEach( ( { path, error } ) => write_line( output, `Could not finish interrupted prune ${ path }: ${ error.message }` ) )
    }

    const initial = await inspect_inventory( inventory_options )
    print_inventory_summary( initial, output )

    if( cmd.flags.list ) {
        if( !initial.clones.length ) write_line( output, `No clone workspaces found.` )
        else print_clone_table( initial.clones, output, now() )
        return
    }

    if( !initial.clones.length ) {
        write_line( output, `No clone workspaces found.` )
        return
    }

    const rl = ask ? null : createInterface( { input, output } )
    const question = ask || ( prompt => rl.question( prompt ) )

    try {
        const policy = await choose_policy( question, output )
        const candidates = select_prune_candidates( initial.clones, policy, now() )

        if( !candidates.length ) {
            write_line( output, `No clone workspaces match that policy.` )
            return
        }

        print_clone_table( candidates, output, now() )
        const total_bytes = candidates.reduce( ( total, clone ) => total + clone.size_bytes, 0 )
        const confirmed = /^(?:y|yes)$/i.test( ( await question(
            `Prune ${ candidates.length } clone workspaces (${ format_size( total_bytes ) })? [y/N] `
        ) ).trim() )
        if( !confirmed ) {
            write_line( output, `Prune cancelled.` )
            return
        }

        let pruned = 0
        for( const clone of candidates ) {
            try {
                const result = await prune_clone( {
                    clone,
                    session_ids: clone.records.map( ( { session } ) => session.babysit_id ).filter( Boolean ),
                    clones_dir,
                    mark_sessions,
                    now: now(),
                    revalidate: async current => {
                        const fresh = await inspect_inventory( {
                            ...inventory_options,
                            inspect_locks: false,
                            clone_ids: [ current.clone_id ],
                        } )
                        const refreshed = fresh.clones.find( item => item.clone_id === current.clone_id )
                        if( !refreshed ) return `clone ownership changed`
                        if( !select_prune_candidates( [ refreshed ], policy, now() ).length ) {
                            return refreshed.status === `available` ? `clone no longer meets age policy` : refreshed.status
                        }
                        return {
                            session_ids: refreshed.records
                                .map( ( { session } ) => session.babysit_id )
                                .filter( Boolean ),
                        }
                    },
                } )

                if( result.pruned ) {
                    pruned++
                    write_line( output, `Pruned ${ clone.clone_id }` )
                } else write_line( output, `Skipped ${ clone.clone_id }: ${ result.reason }` )
            } catch ( error ) {
                write_line( output, `Could not prune ${ clone.clone_id }: ${ error.message }` )
            }
        }

        write_line( output, `Pruned ${ pruned } of ${ candidates.length } clone workspaces.` )
    } finally {
        rl?.close()
    }

}
