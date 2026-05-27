import { detect_platform } from '../utils/platform.js'
import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import { setup_darwin_credentials } from './darwin.js'
import { setup_linux_credentials } from './linux.js'

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
 * @returns {Object|null} Aggregate sync controller or null when no sync exists
 */
const aggregate_syncs = ( syncs ) => {

    const active_syncs = syncs.filter( Boolean )
    if( !active_syncs.length ) return null

    return {
        stop: async () => {
            await Promise.all( active_syncs.map( sync => sync.stop() ) )
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

        // Monitor processes cannot add mounts to an already-running container.
        // Only reattach sync to tmpfiles the foreground actually mounted.
        if( is_monitor_reuse && !existing_tmpfile ) continue

        const sync_baseline = sync_baselines[ credential_agent.name ]
            || ( is_active_agent ? options.sync_baseline : null )

        const result = await setup_platform_credentials( credential_agent, {
            existing_tmpfile,
            sync_baseline,
        } )

        mounts.push( ...result.mounts )
        if( result.sync ) syncs.push( result.sync )

        const mounted_tmpfile = result.mounts.find( m => m.type === `volume` )?.source
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
