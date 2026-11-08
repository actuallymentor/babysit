import { randomUUID } from 'crypto'
import { readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'

import { detect_platform } from '../utils/platform.js'
import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import { log } from '../utils/log.js'
import { setup_agent_credentials } from './setup.js'
import { create_docker_file_transport } from '../docker/file_transport.js'
import { CREDENTIAL_STATE_DIR } from '../utils/paths.js'
import { hash_credential_content, read_sync_state, remove_sync_state, write_sync_state } from './refresh.js'

const EPHEMERAL_CREDENTIAL_PREFIXES = [
    `babysit-chrome-chrome-seccomp.json-`,
    `babysit-gh-hosts.yml-`,
    `babysit-gh-credentials.env-`,
    `babysit-credentials-env-`,
    `babysit-claude-account-env-`,
    `babysit-creds-`,
    `babysit-mac-creds-`,
    `babysit-opencode-`,
]
const STALE_EPHEMERAL_CREDENTIAL_AGE_MS = 60 * 60 * 1_000

/**
 * Remove host-side credential transport files after Docker has consumed them.
 * Long-lived agent credential sync files do not carry a cleanup path and
 * remain untouched so their controllers can continue using them.
 * @param {Object[]} mounts - Credential mount/env descriptors
 * @returns {boolean} True when every cleanup path was removed
 */
export const cleanup_ephemeral_credential_mounts = ( mounts = [] ) => {

    let cleaned = true

    const cleanup_paths = [ ...new Set( mounts
        .map( mount => mount.cleanup )
        .filter( Boolean )
    ) ]

    cleanup_paths.forEach( path => {
        try {
            rmSync( path, { recursive: true, force: true } )
        } catch ( e ) {
            cleaned = false
            log.warn( `Failed to remove ephemeral credential transport ${ path }: ${ e.message }` )
        }
    } )

    return cleaned

}

/**
 * Remove abandoned private launch transports from earlier crashes.
 * Fresh transports are left alone so concurrent Babysit launches cannot race.
 * @param {Object} [options]
 * @param {string} [options.directory=tmpdir()] - Temporary directory to sweep
 * @param {number} [options.now=Date.now()] - Current epoch milliseconds
 * @param {number} [options.max_age_ms=STALE_EPHEMERAL_CREDENTIAL_AGE_MS] - Minimum age to remove
 * @param {string[]} [options.protected_paths=[]] - Active/recoverable transport directories
 * @returns {number} Number of stale directories removed
 */
export const cleanup_stale_ephemeral_credential_mounts = ( {
    directory = tmpdir(),
    now = Date.now(),
    max_age_ms = STALE_EPHEMERAL_CREDENTIAL_AGE_MS,
    protected_paths = [],
} = {} ) => {

    let entries

    try {
        entries = readdirSync( directory, { withFileTypes: true } )
    } catch ( e ) {
        log.debug( `Could not inspect stale credential transports in ${ directory }: ${ e.message }` )
        return 0
    }

    let removed = 0
    const protected_set = new Set( protected_paths )

    entries
        .filter( entry => entry.isDirectory() )
        .filter( entry => EPHEMERAL_CREDENTIAL_PREFIXES.some( prefix => entry.name.startsWith( prefix ) ) )
        .forEach( entry => {
            const path = join( directory, entry.name )

            try {
                if( protected_set.has( path ) ) return
                if( now - statSync( path ).mtimeMs < max_age_ms ) return

                rmSync( path, { recursive: true, force: true } )
                removed += 1
            } catch ( e ) {
                log.warn( `Failed to remove stale credential transport ${ path }: ${ e.message }` )
            }
        } )

    return removed

}

/**
 * Return all credential-bearing agents, with the active agent first so legacy
 * single-agent metadata still points at the session's primary CLI.
 * @param {Object} active_agent - Agent adapter selected for this session
 * @returns {Object[]} Agent adapters
 */
const get_credential_agents = ( active_agent ) => [
    active_agent,
    ...SUPPORTED_AGENTS
        .filter( name => name !== active_agent.name )
        .map( get_agent )
        .filter( Boolean ),
]

/**
 * Stop every active credential sync controller.
 * @param {Object[]} syncs - Individual sync controllers
 * @param {Object} [options]
 * @param {Function} [options.create_transport=create_docker_file_transport] - Docker transport factory
 * @returns {Object|null} Aggregate sync controller or null when no sync exists
 */
export const aggregate_syncs = ( syncs, {
    create_transport = create_docker_file_transport,
} = {} ) => {

    const active_syncs = syncs.filter( Boolean )
    if( !active_syncs.length ) return null

    return {
        baselines: () => Object.fromEntries(
            active_syncs
                .filter( ( { controller, name } ) => name && controller.baseline )
                .map( ( { controller, name } ) => [ name, controller.baseline() ] )
        ),
        source_changed: name => active_syncs
            .filter( sync => !name || sync.name === name )
            .some( ( { controller } ) => controller.source_changed?.() === true ),
        // Receive the agent name whenever one controller writes a rotated
        // credential back to its host file.
        on_pull: handler => {
            active_syncs.forEach( ( { controller, name } ) => controller.on_pull?.( () => handler( name ) ) )
        },
        connect: container_id => {
            active_syncs.forEach( ( { controller, target } ) => {
                controller.set_transport( create_transport( container_id, target ) )
            } )
        },
        // After a successful final flush only: copies first, then the
        // durable states that pointed at them
        cleanup: () => {
            const copies_removed = cleanup_ephemeral_credential_mounts(
                active_syncs.map( ( { cleanup_path } ) => ( { cleanup: cleanup_path } ) )
            )
            if( !copies_removed ) return false
            return active_syncs.map( ( { state_path } ) => remove_sync_state( state_path ) ).every( Boolean )
        },
        flush: async name => {
            const selected_syncs = active_syncs.filter( sync => !name || sync.name === name )
            const results = await Promise.allSettled(
                selected_syncs.map( ( { controller } ) => controller.flush?.() )
            )
            const failures = results
                .filter( result => result.status === `rejected` )
                .map( result => result.reason )

            if( failures.length === 1 ) throw failures[0]
            if( failures.length > 1 ) {
                throw new AggregateError( failures, `Failed to reconcile ${ failures.length } credential files` )
            }
        },
        stop: async () => {
            const results = await Promise.allSettled(
                active_syncs.map( ( { controller } ) => controller.stop() )
            )
            const failures = results
                .filter( result => result.status === `rejected` )
                .map( result => result.reason )

            if( failures.length === 1 ) throw failures[0]
            if( failures.length > 1 ) {
                throw new AggregateError( failures, `Failed to flush ${ failures.length } credential files` )
            }
        },
    }

}

/**
 * One-time reader shim for session records written before durable sync
 * state: turn `creds_tmpfile(s)` + `creds_sync_baseline(s)` into state files.
 * Records that already carry `creds_states` return them unchanged.
 * @param {Object} session - Stored session record
 * @param {Object} [options]
 * @param {string} [options.state_dir=CREDENTIAL_STATE_DIR] - State directory
 * @returns {Object} agent name → state file path
 */
export const session_credential_states = ( session = {}, { state_dir = CREDENTIAL_STATE_DIR } = {} ) => {

    if( session.creds_states ) return session.creds_states

    const tmpfiles = session.creds_tmpfiles || ( session.creds_tmpfile ? { [ session.agent ]: session.creds_tmpfile } : {} )

    return Object.fromEntries( Object.entries( tmpfiles ).filter( ( [ , tmpfile ] ) => tmpfile ).map( ( [ name, tmpfile ] ) => {

        const path = join( state_dir, `${ basename( String( session.babysit_id || `legacy` ) ) }-${ name }.json` )
        if( read_sync_state( path ) ) return [ name, path ]

        // Without stored hashes the copy itself is the agreed point, as the
        // legacy monitor seeded it
        const baseline = session.creds_sync_baselines?.[ name ]
            || ( name === session.agent ? session.creds_sync_baseline : null )
            || {}
        let copy_hash = null
        try {
            copy_hash = hash_credential_content( readFileSync( tmpfile, `utf-8` ) )
        } catch { /* Recovery may rebuild a copy /tmp lost at boot */ }

        write_sync_state( path, {
            tmpfile,
            source_hash: baseline.baseline_source_hash ?? copy_hash,
            synced_hash: baseline.baseline_tmpfile_hash ?? baseline.baseline_source_hash ?? copy_hash,
            ...baseline.credential_source && { credential_source: baseline.credential_source },
        } )
        return [ name, path ]

    } ) )

}

/**
 * Staged copy paths named by durable sync states.
 * @param {Object} states - agent name → state file path
 * @returns {Object} agent name → copy path
 */
export const credential_state_tmpfiles = ( states = {} ) => Object.fromEntries(
    Object.entries( states )
        .map( ( [ name, path ] ) => [ name, read_sync_state( path )?.tmpfile ] )
        .filter( ( [ , tmpfile ] ) => tmpfile )
)

/**
 * Set up credential passthrough for every supported agent. Fresh captures
 * write one durable sync state per staged login; a monitor (or recovery)
 * passes those states back to reattach to the same copies.
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {Object} [options.existing_states] - agent name → state path to reattach (monitor case)
 * @param {string} [options.state_dir=CREDENTIAL_STATE_DIR] - Where fresh captures keep state
 * @param {'darwin'|'linux'} [options.platform] - Host platform seam
 * @returns {Promise<{ mounts: Array, sync: Object|null, states: Object, tmpfiles: Object }>}
 */
export const setup_credentials = async ( agent, options = {} ) => {

    const platform = options.platform || detect_platform()
    const state_dir = options.state_dir || CREDENTIAL_STATE_DIR
    const is_monitor_reuse = Object.hasOwn( options, `existing_states` )
    const existing_states = options.existing_states || {}
    const capture_id = randomUUID()

    const mounts = []
    const syncs = []
    const tmpfiles = {}
    const states = {}

    for( const credential_agent of get_credential_agents( agent ) ) {

        const { name } = credential_agent
        const existing_state = existing_states[ name ] ? read_sync_state( existing_states[ name ] ) : null

        // Monitor processes cannot stage new files into an unrelated launch.
        // Only reattach sync to copies captured by the foreground.
        if( is_monitor_reuse && !existing_state ) {
            if( existing_states[ name ] ) log.warn( `Credential sync state for ${ name } is missing: ${ existing_states[ name ] }` )
            continue
        }

        // Claude's subscription login enters containers only as a setup-token
        // (account env file, hot swap). Its host /login is never staged, so it
        // neither races sessions for one-use refresh tokens nor receives the
        // token back. Only legacy sessions that captured it keep their sync.
        if( !existing_state && credential_agent.credentials?.stage_host_login === false ) continue

        const state_path = existing_states[ name ] || join( state_dir, `${ capture_id }-${ name }.json` )
        const result = setup_agent_credentials( credential_agent, {
            platform,
            state_path,
            existing_tmpfile: existing_state?.tmpfile || null,
            sync_baseline: existing_state?.credential_source ? { credential_source: existing_state.credential_source } : null,
            ...options.read_keychain && { read_keychain: options.read_keychain },
        } )

        mounts.push( ...result.mounts )
        if( result.sync ) {
            syncs.push( {
                controller: result.sync,
                name,
                target: credential_agent.container_paths.creds,
                cleanup_path: result.cleanup_path,
                state_path,
            } )
            states[ name ] = state_path
        }

        const tmpfile = existing_state?.tmpfile || result.mounts.find( m => m.type === `synced_file` )?.source
        if( tmpfile ) tmpfiles[ name ] = tmpfile

    }

    return {
        mounts,
        sync: aggregate_syncs( syncs ),
        states,
        tmpfiles,
    }

}
