import { createHash } from 'crypto'
import {
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'fs'
import { dirname, join } from 'path'

import { get_image_name } from '../docker/update.js'
import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { BABYSIT_DIR } from '../utils/paths.js'

export const HOST_AUTH_CACHE_PATH = join( BABYSIT_DIR, `host-auth-cache.json` )
export const HOST_AUTH_CACHE_TTL_MS = 12 * 60 * 60 * 1_000

const empty_cache = () => ( { version: 1, agents: {} } )
const hash_value = value => createHash( `sha256` ).update( String( value ) ).digest( `hex` )
const CACHE_LOCK_TIMEOUT_MS = 2_000
const CACHE_LOCK_STALE_MS = CACHE_LOCK_TIMEOUT_MS
const CACHE_LOCK_RETRY_MS = 10
const lock_waiter = new Int32Array( new SharedArrayBuffer( 4 ) )

const wait_sync = milliseconds => Atomics.wait( lock_waiter, 0, 0, milliseconds )

const credential_environment_keys = agent => new Set(
    [ agent?.credentials?.linux, agent?.credentials?.darwin ]
        .filter( Boolean )
        .flatMap( config => [ config.env_key, config.fallback_env ] )
        .filter( Boolean )
)

const with_cache_lock = ( cache_path, task, {
    now = Date.now,
    wait = wait_sync,
} = {} ) => {

    const directory = dirname( cache_path )
    const lock_path = `${ cache_path }.lock`
    const deadline = now() + CACHE_LOCK_TIMEOUT_MS

    mkdirSync( directory, { recursive: true } )

    while( true ) {
        try {
            mkdirSync( lock_path, { mode: 0o700 } )
            break
        } catch ( error ) {
            if( error.code !== `EEXIST` ) throw error

            try {
                if( now() - statSync( lock_path ).mtimeMs >= CACHE_LOCK_STALE_MS ) {
                    rmSync( lock_path, { recursive: true, force: true } )
                    continue
                }
            } catch {
                continue
            }

            if( now() >= deadline ) throw new Error( `Authentication cache is busy` )
            wait( CACHE_LOCK_RETRY_MS )
        }
    }

    try {
        return task()
    } finally {
        rmSync( lock_path, { recursive: true, force: true } )
    }

}

/**
 * Combine already-hashed credential parts into one stable fingerprint.
 * @param {Object[]} parts - Safe hashed credential descriptors
 * @returns {string} Combined SHA-256 fingerprint
 */
export const fingerprint_credential_parts = ( parts = [] ) => hash_value( JSON.stringify( parts ) )

/**
 * Select only credential descriptors consumed by one agent.
 * Shared session setup captures every agent so nested calls work, but an auth
 * probe needs only the credential file and environment keys for its own CLI.
 *
 * @param {Object} agent - Agent adapter
 * @param {Object[]} mounts - All credential descriptors
 * @returns {Object[]} Agent-scoped descriptors, preserving input order
 */
export const credential_mounts_for_agent = ( agent, mounts = [] ) => {

    const environment_keys = credential_environment_keys( agent )
    const credential_target = agent?.container_paths?.creds

    return mounts.filter( mount =>
        mount?.target === credential_target
        ||  [ `env`, `secret_env` ].includes( mount?.type ) && environment_keys.has( mount.key )
    )

}

/**
 * Read the hash-only authentication cache. Corrupt or unknown shapes miss
 * safely; startup can always fall back to a real probe.
 *
 * @param {Object} [options]
 * @param {string} [options.cache_path] - Cache file path
 * @returns {{ version: number, agents: Object }} Parsed cache
 */
export const read_host_auth_cache = ( {
    cache_path = HOST_AUTH_CACHE_PATH,
} = {} ) => {

    try {
        if( !existsSync( cache_path ) ) return empty_cache()

        const parsed = JSON.parse( readFileSync( cache_path, `utf-8` ) )
        if( parsed?.version !== 1 || !parsed.agents || typeof parsed.agents !== `object` ) {
            return empty_cache()
        }

        return parsed
    } catch {
        return empty_cache()
    }

}

const write_host_auth_cache = ( cache, {
    cache_path = HOST_AUTH_CACHE_PATH,
} = {} ) => {

    const directory = dirname( cache_path )
    const temporary_path = `${ cache_path }.${ process.pid }.tmp`

    mkdirSync( directory, { recursive: true } )

    try {
        writeFileSync( temporary_path, `${ JSON.stringify( cache, null, 2 ) }\n`, { mode: 0o600 } )
        renameSync( temporary_path, cache_path )
    } finally {
        rmSync( temporary_path, { force: true } )
    }

    return cache
}

/**
 * Hash the credential inputs relevant to one agent. File and environment
 * values are reduced to SHA-256 before this descriptor can reach session or
 * cache metadata.
 *
 * @param {Object} agent - Agent adapter
 * @param {Object[]} mounts - Credential mounts produced by setup_credentials
 * @param {Object} [options]
 * @param {Function} [options.read_file=readFileSync] - File reader seam
 * @param {Object<string,string|Object>} [options.context_files] - Auth-relevant files keyed by safe labels
 * @returns {{ fingerprint: string, parts: Object[] }|null} Safe fingerprint metadata
 */
export const fingerprint_agent_credentials = ( agent, mounts = [], {
    read_file = readFileSync,
    context_files = {},
} = {} ) => {

    const credential_target = agent?.container_paths?.creds
    const parts = []

    for( const mount of credential_mounts_for_agent( agent, mounts ) ) {
        if( mount?.target === credential_target && mount.source ) {
            try {
                parts.push( {
                    kind: `file`,
                    target: credential_target,
                    hash: hash_value( read_file( mount.source ) ),
                } )
            } catch {
                return null
            }
        }

        if( [ `env`, `secret_env` ].includes( mount?.type )
            && typeof mount.value === `string` ) {
            parts.push( {
                kind: `env`,
                key: mount.key,
                hash: hash_value( mount.value ),
            } )
        }
    }

    for( const [ key, descriptor ] of Object.entries( context_files ) ) {
        const path = typeof descriptor === `string` ? descriptor : descriptor.path
        try {
            const raw = read_file( path )
            const effective_content = typeof descriptor?.transform === `function`
                ? descriptor.transform( raw )
                : raw
            parts.push( {
                kind: `context`,
                key,
                hash: hash_value( effective_content ),
            } )
        } catch {
            // A carried nested-Docker path may be readable by the outer daemon
            // but not this process. Disable caching instead of trusting an
            // identity that omits an effective authentication input.
            return null
        }
    }

    if( !parts.length ) return null

    parts.sort( ( left, right ) =>
        `${ left.kind }:${ left.target || left.key }`.localeCompare( `${ right.kind }:${ right.target || right.key }` )
    )

    return {
        fingerprint: fingerprint_credential_parts( parts ),
        parts,
    }

}

/**
 * Replace file-backed hashes after a trusted session final flush. Environment
 * hashes stay unchanged because the container cannot rotate host env values.
 *
 * @param {Object[]} parts - Safe pre-launch credential parts
 * @param {string|null} credential_file - Final staged credential file
 * @param {Object} [options]
 * @param {Function} [options.read_file=readFileSync] - File reader seam
 * @returns {{ fingerprint: string, parts: Object[] }|null} Refreshed metadata
 */
export const refresh_file_credential_parts = ( parts = [], credential_file, {
    read_file = readFileSync,
} = {} ) => {

    if( !parts.some( part => part.kind === `file` ) ) {
        return { fingerprint: fingerprint_credential_parts( parts ), parts }
    }
    if( !credential_file ) return null

    let file_hash
    try {
        file_hash = hash_value( read_file( credential_file ) )
    } catch {
        return null
    }

    const refreshed_parts = parts.map( part => part.kind === `file`
        ? { ...part, hash: file_hash }
        : part
    )

    return {
        fingerprint: fingerprint_credential_parts( refreshed_parts ),
        parts: refreshed_parts,
    }

}

/**
 * Resolve the immutable ID of the local image used for auth probes.
 * @param {Object} [options]
 * @param {Function} [options.run_command=run] - Command runner seam
 * @param {string} [options.image=get_image_name()] - Docker image reference
 * @param {string[]} [options.command_prefix=docker_command_prefix()] - Docker prefix
 * @returns {Promise<string|null>} Local image ID, or null when unavailable
 */
export const resolve_auth_image_identity = async ( {
    run_command = run,
    image = get_image_name(),
    command_prefix = docker_command_prefix(),
} = {} ) => {

    const [ command, ...prefix_args ] = command_prefix

    try {
        const identity = await run_command(
            command,
            [ ...prefix_args, `image`, `inspect`, image, `--format`, `{{.Id}}` ],
            {},
            30_000
        )
        return identity || null
    } catch {
        return null
    }

}

/**
 * Find a fresh success matching current credential and image identity.
 * @param {string} name - Agent name
 * @param {Object} identity - Current fingerprint and image identity
 * @param {Object} [options]
 * @returns {Object|null} Matching cache entry
 */
export const find_host_auth_cache_hit = ( name, {
    credential_fingerprint,
    image_identity,
}, {
    cache_path = HOST_AUTH_CACHE_PATH,
    now = Date.now(),
    ttl_ms = HOST_AUTH_CACHE_TTL_MS,
} = {} ) => {

    if( !credential_fingerprint || !image_identity ) return null

    const entry = read_host_auth_cache( { cache_path } ).agents[ name ]
    const authenticated_at = Date.parse( entry?.authenticated_at )

    if( !Number.isFinite( authenticated_at ) ) return null
    if( now - authenticated_at >= ttl_ms ) return null
    if( entry.credential_fingerprint !== credential_fingerprint ) return null
    if( entry.image_identity !== image_identity ) return null

    return entry
}

/**
 * Persist one successful real authentication check.
 * @param {string} name - Agent name
 * @param {Object} identity - Verified fingerprint and image identity
 * @param {Object} [options]
 * @returns {Object|null} Written cache entry
 */
export const record_host_auth_success = ( name, {
    credential_fingerprint,
    image_identity,
}, {
    cache_path = HOST_AUTH_CACHE_PATH,
    now = Date.now(),
} = {} ) => {

    if( !credential_fingerprint || !image_identity ) return null

    const entry = {
        authenticated_at: new Date( now ).toISOString(),
        credential_fingerprint,
        image_identity,
    }

    try {
        return with_cache_lock( cache_path, () => {
            const cache = read_host_auth_cache( { cache_path } )
            cache.agents[ name ] = entry
            write_host_auth_cache( cache, { cache_path } )
            return entry
        } )
    } catch {
        // Cache metadata is optional. A verified launch must not fail because
        // its optimization file is unavailable or another process is writing.
        return null
    }
}

/**
 * Invalidate one agent after a real failed authentication check.
 * @param {string} name - Agent name
 * @param {Object} [options]
 * @param {string} [options.expected_credential_fingerprint] - Delete only this observed generation
 * @param {string} [options.image_identity] - Expected image generation
 * @param {Function} [options.lock_cache] - Cache lock seam
 * @returns {boolean} Whether the stale cache entry is absent
 */
export const clear_host_auth_cache = ( name, {
    cache_path = HOST_AUTH_CACHE_PATH,
    expected_credential_fingerprint = null,
    image_identity = null,
    lock_cache = with_cache_lock,
} = {} ) => {

    try {
        return lock_cache( cache_path, () => {
            const cache = read_host_auth_cache( { cache_path } )
            if( !Object.hasOwn( cache.agents, name ) ) return true

            const entry = cache.agents[ name ]
            if( expected_credential_fingerprint
                && entry.credential_fingerprint !== expected_credential_fingerprint ) return true
            if( image_identity && entry.image_identity !== image_identity ) return true

            delete cache.agents[ name ]
            write_host_auth_cache( cache, { cache_path } )
            return true
        } )
    } catch {
        // A cache lock or write failure cannot safely disprove this entry.
        // Leave every agent's last atomic snapshot intact; the caller already
        // has the live probe result and can fail closed for this launch.
        return false
    }
}

/**
 * Re-stamp a fresh matching cache entry after a trusted token rotation.
 * Compare-and-swap prevents one session from blessing credentials replaced by
 * a concurrent launch or explicit doctor check.
 *
 * @param {string} name - Agent name
 * @param {Object} identity - Expected and refreshed credential identity
 * @param {Object} [options]
 * @returns {boolean} Whether the entry was refreshed
 */
export const refresh_host_auth_cache = ( name, {
    expected_credential_fingerprint,
    next_credential_fingerprint,
    image_identity,
}, {
    cache_path = HOST_AUTH_CACHE_PATH,
    now = Date.now(),
    ttl_ms = HOST_AUTH_CACHE_TTL_MS,
} = {} ) => {

    if( !expected_credential_fingerprint || !next_credential_fingerprint || !image_identity ) return false

    try {
        return with_cache_lock( cache_path, () => {
            const cache = read_host_auth_cache( { cache_path } )
            const entry = cache.agents[ name ]
            const authenticated_at = Date.parse( entry?.authenticated_at )

            if( !Number.isFinite( authenticated_at ) || now - authenticated_at >= ttl_ms ) return false
            if( entry.credential_fingerprint !== expected_credential_fingerprint ) return false
            if( entry.image_identity !== image_identity ) return false

            cache.agents[ name ] = {
                ...entry,
                credential_fingerprint: next_credential_fingerprint,
            }
            write_host_auth_cache( cache, { cache_path } )
            return true
        } )
    } catch {
        return false
    }
}
