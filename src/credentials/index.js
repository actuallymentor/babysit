import { readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { detect_platform } from '../utils/platform.js'
import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import { log } from '../utils/log.js'
import { setup_darwin_credentials } from './darwin.js'
import { setup_linux_credentials } from './linux.js'
import { create_docker_file_transport } from '../docker/file_transport.js'

const EPHEMERAL_CREDENTIAL_PREFIXES = [
    `babysit-gh-hosts.yml-`,
    `babysit-gh-credentials.env-`,
    `babysit-credentials-env-`,
    `babysit-creds-`,
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
 * Remove abandoned private GitHub credential transports from earlier crashes.
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
        connect: container_id => {
            active_syncs.forEach( ( { controller, target } ) => {
                controller.set_transport( create_transport( container_id, target ) )
            } )
        },
        cleanup: () => cleanup_ephemeral_credential_mounts(
            active_syncs.map( ( { cleanup_path } ) => ( { cleanup: cleanup_path } ) )
        ),
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
 * Set up credential passthrough for every supported agent, choosing the right platform adapter
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.existing_tmpfile] - Re-use this tmpfile (monitor case)
 *   instead of creating a new one. Legacy monitor handoff for pre-multi-agent sessions.
 * @param {Object} [options.existing_tmpfiles] - Per-agent tmpfiles to re-use in the monitor
 * @param {Object|null} [options.sync_baseline] - Foreground-capture hashes used
 *   when reusing an existing tmpfile in the monitor. Legacy active-agent shape.
 * @param {Object|null} [options.sync_baselines] - Per-agent foreground-capture hashes
 * @returns {Promise<{
 *   mounts: Array,
 *   sync: Object|null,
 *   sync_baseline: Object|null,
 *   sync_baselines: Object,
 *   tmpfiles: Object
 * }>}
 */
export const setup_credentials = async ( agent, options = {} ) => {

    const platform = detect_platform()
    const setup_platform_credentials = platform === `darwin`
        ? setup_darwin_credentials
        : setup_linux_credentials

    const is_monitor_reuse = Object.hasOwn( options, `existing_tmpfile` )
        || Object.hasOwn( options, `existing_tmpfiles` )

    const existing_tmpfiles = options.existing_tmpfiles || {}
    const sync_baselines = options.sync_baselines || {}

    const mounts = []
    const syncs = []
    const tmpfiles = {}
    const next_sync_baselines = {}

    const credential_agents = get_credential_agents( agent )

    for( const credential_agent of credential_agents ) {

        const is_active_agent = credential_agent.name === agent.name
        const existing_tmpfile = existing_tmpfiles[ credential_agent.name ]
            || ( is_active_agent ? options.existing_tmpfile : null )

        // Monitor processes cannot stage new files into an unrelated launch.
        // Only reattach sync to tmpfiles captured by the foreground.
        if( is_monitor_reuse && !existing_tmpfile ) continue

        const sync_baseline = sync_baselines[ credential_agent.name ]
            || ( is_active_agent ? options.sync_baseline : null )

        const result = await setup_platform_credentials( credential_agent, {
            existing_tmpfile,
            sync_baseline,
        } )

        mounts.push( ...result.mounts )
        if( result.sync ) {
            syncs.push( {
                controller: result.sync,
                name: credential_agent.name,
                target: credential_agent.container_paths.creds,
                cleanup_path: result.cleanup_path,
            } )
        }

        const mounted_tmpfile = result.mounts.find( m => m.type === `synced_file` )?.source
        const tmpfile = existing_tmpfile || mounted_tmpfile
        if( tmpfile ) tmpfiles[ credential_agent.name ] = tmpfile
        if( result.sync_baseline ) next_sync_baselines[ credential_agent.name ] = result.sync_baseline

    }

    return {
        mounts,
        sync: aggregate_syncs( syncs ),
        sync_baseline: next_sync_baselines[ agent.name ] || null,
        sync_baselines: next_sync_baselines,
        tmpfiles,
    }

}
