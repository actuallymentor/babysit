import { log } from '../utils/log.js'
import { has_session, list_sessions, attach_session } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'
import { print_active_sessions_table } from './list.js'

/**
 * Find active tmux sessions whose stored Babysit metadata points at a working directory.
 * @param {string} pwd - Working directory to match
 * @param {Array<{ name: string, attached: boolean }>} tmux_sessions - Active tmux sessions
 * @param {Object[]} stored_sessions - Stored Babysit metadata
 * @returns {Array<{ name: string, attached: boolean }>} Matching active sessions
 */
export const active_sessions_for_pwd = ( pwd, tmux_sessions, stored_sessions ) => {

    const active_names = new Set( tmux_sessions.map( session => session.name ) )
    const matching_names = new Set(
        stored_sessions
            .filter( session => session.pwd === pwd && active_names.has( session.tmux_session ) )
            .map( session => session.tmux_session )
    )

    return tmux_sessions.filter( session => matching_names.has( session.name ) )

}

/**
 * Attach to a tmux session. Delegates to the shared `attach_session` helper
 * which JSON.stringifies the session name for shell safety — directly
 * interpolating it would let metacharacters in unusual session names
 * break out of the tmux argument.
 * @param {string} session_name - Tmux session name
 * @param {Function} attach_session_fn - Tmux attach helper
 */
const attach = ( session_name, attach_session_fn ) => {

    log.info( `Attaching to session: ${ session_name }` )
    attach_session_fn( session_name )

}

/**
 * Attach to the only active session associated with the current directory, or
 * print a table when there is more than one possible target.
 * @param {Object} options
 * @param {string} options.cwd - Current working directory
 * @param {Function} options.list_sessions_fn - Active tmux session loader
 * @param {Function} options.list_stored_sessions_fn - Stored metadata loader
 * @param {Function} options.attach_session_fn - Tmux attach helper
 * @param {Function} options.exit_fn - Process exit helper
 */
const open_current_directory_session = async ( {
    cwd,
    list_sessions_fn,
    list_stored_sessions_fn,
    attach_session_fn,
    exit_fn,
} ) => {

    const active = await list_sessions_fn()
    const stored = list_stored_sessions_fn()
    const matches = active_sessions_for_pwd( cwd, active, stored )

    if( matches.length === 1 ) {
        attach( matches[0].name, attach_session_fn )
        return
    }

    if( matches.length > 1 ) {

        // A filtered table keeps the global list ordinals so every displayed
        // number resolves to the same session through `babysit open N`.
        const active_numbers = new Map(
            active.map( ( session, index ) => [ session.name, index + 1 ] )
        )

        print_active_sessions_table( matches, stored, {
            title: `Active babysit sessions for ${ cwd }:`,
            numbered: true,
            numbers: matches.map( session => active_numbers.get( session.name ) ),
        } )
        return
    }

    log.error( `No active session found for current directory: ${ cwd }` )
    log.error( `Run \`babysit list\` to see active sessions.` )
    exit_fn( 1 )

}

/**
 * Attach to an active babysit tmux session
 * @param {Object} cmd - Parsed command { session_id }
 * @param {Object} [deps]
 * @param {Function} [deps.has_session_fn] - Tmux existence check
 * @param {Function} [deps.list_sessions_fn] - Active tmux session loader
 * @param {Function} [deps.list_stored_sessions_fn] - Stored metadata loader
 * @param {Function} [deps.attach_session_fn] - Tmux attach helper
 * @param {Function} [deps.exit_fn] - Process exit helper
 * @param {string} [deps.cwd] - Directory used for zero-arg matching
 */
export const cmd_open = async ( cmd, {
    has_session_fn = has_session,
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    attach_session_fn = attach_session,
    exit_fn = process.exit,
    cwd = process.cwd(),
} = {} ) => {

    const { session_id } = cmd

    if( !session_id ) {
        await open_current_directory_session( {
            cwd,
            list_sessions_fn,
            list_stored_sessions_fn,
            attach_session_fn,
            exit_fn,
        } )
        return
    }

    // All-digit selectors refer to the complete numbered active-session list.
    // Resolve them before fuzzy tmux matching so `babysit open 2` cannot
    // accidentally attach to an unrelated timestamp containing the digit 2.
    if( /^\d+$/.test( session_id ) ) {

        const active = await list_sessions_fn()

        if( active.length === 0 ) {
            log.error( `No active babysit sessions.` )
            exit_fn( 1 )
            return
        }

        const selected = active[ Number( session_id ) - 1 ]

        if( selected ) {
            attach( selected.name, attach_session_fn )
            return
        }

        const stored = list_stored_sessions_fn()
        print_active_sessions_table( active, stored, { numbered: true } )

        log.error( `No active session numbered ${ session_id }.` )
        exit_fn( 1 )
        return

    }

    // Try direct tmux session name match
    if( await has_session_fn( session_id ) ) {
        attach( session_id, attach_session_fn )
        return
    }

    // Preserve the legacy exact metadata-id lookup before human-readable
    // names so a label that happens to equal an id cannot shadow that id.
    const stored = list_stored_sessions_fn()
    const id_match = stored.find( s =>
        s.babysit_id === session_id ||
        s.agent_session_id === session_id
    )

    if( id_match && await has_session_fn( id_match.tmux_session ) ) {
        attach( id_match.tmux_session, attach_session_fn )
        return
    }

    // Resolve exact display names among active sessions. Duplicate names are
    // allowed across workspaces, but never attach arbitrarily when more than
    // one is active — show the disambiguating ids instead.
    const active = await list_sessions_fn()
    const named_tmux_sessions = new Set(
        stored
            .filter( session => session.name === session_id )
            .map( session => session.tmux_session )
    )
    const named_matches = active.filter( session => named_tmux_sessions.has( session.name ) )

    if( named_matches.length === 1 ) {
        attach( named_matches[0].name, attach_session_fn )
        return
    }

    if( named_matches.length > 1 ) {
        print_active_sessions_table( named_matches, stored, {
            title: `Multiple active babysit sessions are named "${ session_id }":`,
        } )
        log.error( `Use \`babysit open <session_id>\` to choose one.` )
        exit_fn( 1 )
        return
    }

    // Preserve partial stored tmux-name matching for existing workflows.
    const tmux_match = stored.find( session => session.tmux_session?.includes( session_id ) )

    if( tmux_match && await has_session_fn( tmux_match.tmux_session ) ) {
        attach( tmux_match.tmux_session, attach_session_fn )
        return
    }

    // Fuzzy match against active sessions
    const fuzzy = active.find( s => s.name.includes( session_id ) )

    if( fuzzy ) {
        attach( fuzzy.name, attach_session_fn )
        return
    }

    log.error( `No active session found for: ${ session_id }` )
    log.error( `Run \`babysit list\` to see active sessions.` )
    exit_fn( 1 )

}
