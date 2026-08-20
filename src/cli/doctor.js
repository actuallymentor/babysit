import { get_agent, SUPPORTED_AGENTS } from '../agents/index.js'
import {
    check_host_agent_authentication,
    run_host_agent_auth_check,
} from '../agents/auth.js'
import {
    clear_host_auth_cache,
    find_host_auth_cache_hit,
    fingerprint_agent_credentials,
    record_host_auth_success,
    resolve_auth_image_identity,
} from '../agents/auth_cache.js'
import { cleanup_ephemeral_credential_mounts, setup_credentials } from '../credentials/index.js'
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
    cache_path = undefined,
} = {} ) => {

    if( !cmd.flags.auth ) {
        throw new Error( `Choose a diagnostic, for example: babysit doctor --auth` )
    }

    const agents = select_doctor_auth_agents( cmd.auth_agent )
    const cache_options = cache_path ? { cache_path } : {}
    const {
        mounts: creds_mounts,
        sync: creds_sync,
        tmpfiles: creds_tmpfiles,
    } = await setup( agents[0] )
    const recovery_id = register_credential_recovery( {
        sync_paths: Object.values( creds_tmpfiles ).map(
            file => private_credential_tmpdir( file ) || file
        ),
    } )

    try {
        const image_identity = await resolve_image_identity()
        const identities = new Map( agents.map( agent => [
            agent.name,
            fingerprint_agent_credentials( agent, creds_mounts ),
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
                    run_auth_check: ( agent, options ) => run_auth_check( agent, {
                        ...options,
                        workspace,
                        mode: {},
                        creds_mounts,
                        config: { isolate_dependencies: false },
                    } ),
                } ), {
                input,
                output,
                allow_skip: false,
            } )
            : []

        for( const result of checked_results ) {
            if( result.status !== `authenticated` ) {
                if( [ `unauthenticated`, `failed` ].includes( result.status ) ) {
                    clear_host_auth_cache( result.name, cache_options )
                }
                continue
            }

            const agent = get_agent( result.name )
            const identity = fingerprint_agent_credentials( agent, creds_mounts )
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
            if( cleaned ) clear_credential_recovery( recovery_id )
        }
    }

}
