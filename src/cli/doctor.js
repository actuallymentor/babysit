import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import {
    check_host_agent_authentication,
    resolve_host_auth_context_files,
    run_host_agent_auth_check,
} from '../agents/auth.js'
import {
    clear_host_auth_cache,
    credential_mounts_for_agent,
    find_host_auth_cache_hit,
    fingerprint_agent_credentials,
    record_host_auth_success,
    resolve_auth_image_identity,
} from '../agents/auth_cache.js'
import { cleanup_ephemeral_credential_mounts, setup_credentials } from '../credentials/index.js'
import { acquire_host_auth_lease } from '../agents/auth_lease.js'
import {
    clear_credential_recovery,
    register_credential_recovery,
} from '../credentials/recovery.js'
import { private_credential_tmpdir } from '../utils/tmpfile.js'
import { run_auth_checks_with_progress } from './auth_progress.js'

/**
 * Resolve `doctor --auth` agent selection.
 * @param {string|null} selection - Agent name or all
 * @returns {Object[]} Selected adapters
 */
export const select_doctor_auth_agents = ( selection = `all` ) => {

    const names = !selection || selection === `all`
        ? SUPPORTED_AGENTS
        : [ selection ]
    const agents = names.map( get_agent ).filter( Boolean )

    if( agents.length !== names.length ) {
        throw new Error( `Unsupported doctor authentication agent: ${ selection }` )
    }

    return agents
}

/**
 * Run explicit model-backed authentication diagnostics.
 * @param {Object} cmd - Parsed doctor command
 * @param {Object} [dependencies] - Injectable test seams
 * @returns {Promise<Object[]>} Per-agent results
 */
export const cmd_doctor = async ( cmd, {
    input = process.stdin,
    output = process.stdout,
    workspace = process.cwd(),
    setup = setup_credentials,
    run_auth_check = run_host_agent_auth_check,
    resolve_image_identity = resolve_auth_image_identity,
    resolve_context_files = resolve_host_auth_context_files,
    cache_path = undefined,
    acquire_lease = acquire_host_auth_lease,
    register_recovery = register_credential_recovery,
    clear_recovery = clear_credential_recovery,
} = {} ) => {

    if( !cmd.flags.auth ) {
        throw new Error( `Choose a diagnostic, for example: babysit doctor --auth` )
    }

    const agents = select_doctor_auth_agents( cmd.auth_agent )
    const cache_options = cache_path ? { cache_path } : {}
    const auth_lease = await acquire_lease()
    let credential_setup
    try {
        credential_setup = await setup( agents[0] )
    } catch ( error ) {
        auth_lease.release()
        throw error
    }
    const {
        mounts: creds_mounts,
        sync: creds_sync,
        tmpfiles: creds_tmpfiles,
    } = credential_setup
    let recovery_id = null

    try {
        recovery_id = register_recovery( {
            sync_paths: Object.values( creds_tmpfiles ).map(
                file => private_credential_tmpdir( file ) || file
            ),
        } )

        const image_identity = await resolve_image_identity()
        const context_files = new Map( agents.map( agent => [
            agent.name,
            resolve_context_files( {}, { agent } ),
        ] ) )
        const identities = new Map( agents.map( agent => [
            agent.name,
            fingerprint_agent_credentials( agent, creds_mounts, {
                context_files: context_files.get( agent.name ),
            } ),
        ] ) )
        const cached_results = []
        const agents_to_check = []

        for( const agent of agents ) {
            if( cmd.flags.refresh ) clear_host_auth_cache( agent.name, cache_options )

            const identity = identities.get( agent.name )
            const hit = !cmd.flags.refresh && identity && find_host_auth_cache_hit( agent.name, {
                credential_fingerprint: identity.fingerprint,
                image_identity,
            }, cache_options )

            if( hit ) {
                cached_results.push( {
                    name: agent.name,
                    status: `cached`,
                    authenticated: true,
                } )
            } else {
                agents_to_check.push( agent )
            }
        }

        const checked_results = agents_to_check.length
            ? await run_auth_checks_with_progress( agents_to_check, ( { signal, on_state } ) =>
                check_host_agent_authentication( {
                    agents: agents_to_check,
                    signal,
                    on_state,
                    run_auth_check: async ( agent, options ) => {
                        const result = await run_auth_check( agent, {
                            ...options,
                            workspace,
                            mode: {},
                            creds_mounts: credential_mounts_for_agent( agent, creds_mounts ),
                            config: { isolate_dependencies: false },
                        } )
                        if( result.status !== `authenticated` ) return result

                        try {
                            await creds_sync?.flush?.( agent.name )
                        } catch ( error ) {
                            return {
                                ...result,
                                status: `failed`,
                                authenticated: false,
                                reason: `credential reconciliation failed: ${ error.message }`,
                            }
                        }

                        if( creds_sync?.source_changed?.( agent.name ) ) {
                            return {
                                ...result,
                                status: `failed`,
                                authenticated: false,
                                reason: `host credentials changed during authentication`,
                            }
                        }

                        return result
                    },
                } ), {
                input,
                output,
                allow_skip: false,
            } )
            : []

        for( const result of checked_results ) {
            if( result.status !== `authenticated` ) {
                if( [ `unauthenticated`, `failed` ].includes( result.status ) ) {
                    clear_host_auth_cache( result.name, {
                        ...cache_options,
                        expected_credential_fingerprint: identities.get( result.name )?.fingerprint,
                        image_identity,
                    } )
                }
                continue
            }

            const agent = get_agent( result.name )
            const identity = fingerprint_agent_credentials( agent, creds_mounts, {
                context_files: context_files.get( agent.name ),
            } )
            const initial_context = identities.get( result.name )?.parts
                ?.filter( part => part.kind === `context` )
            const verified_context = identity?.parts.filter( part => part.kind === `context` )
            if( JSON.stringify( initial_context ) !== JSON.stringify( verified_context ) ) {
                result.status = `failed`
                result.authenticated = false
                result.reason = `authentication context changed during the check`
                clear_host_auth_cache( result.name, {
                    ...cache_options,
                    expected_credential_fingerprint: identities.get( result.name )?.fingerprint,
                    image_identity,
                } )
                continue
            }
            if( identity && image_identity ) {
                record_host_auth_success( result.name, {
                    credential_fingerprint: identity.fingerprint,
                    image_identity,
                }, cache_options )
            }
        }

        const results_by_name = new Map(
            [ ...cached_results, ...checked_results ].map( result => [ result.name, result ] )
        )
        const results = agents.map( agent => results_by_name.get( agent.name ) )

        results.forEach( result => {
            output.write( `${ result.name }: ${ result.status }${ result.reason ? ` (${ result.reason })` : `` }\n` )
        } )
        return results
    } finally {
        let cleaned = false
        try {
            await creds_sync?.stop()
            cleaned = creds_sync?.cleanup?.() ?? cleanup_ephemeral_credential_mounts( creds_mounts )
        } finally {
            if( cleaned && recovery_id ) clear_recovery( recovery_id )
            auth_lease.release()
        }
    }

}
