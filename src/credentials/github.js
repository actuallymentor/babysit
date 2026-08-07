import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { stringify } from 'yaml'

import { log } from '../utils/log.js'
import { build_tmpdir_with_files } from '../utils/tmpfile.js'

export const GH_CONFIG_CONTAINER_DIR = `/home/node/.config/gh`
const GH_AUTH_STATUS_TIMEOUT_MS = 10_000

/**
 * Resolve the host-side GitHub CLI config directory using gh's documented
 * precedence.
 * @param {Object} [env=process.env] - Environment to inspect
 * @returns {string} Host gh config directory
 */
export const resolve_host_gh_config_dir = ( env = process.env ) => {

    if( env.GH_CONFIG_DIR ) return env.GH_CONFIG_DIR
    if( env.XDG_CONFIG_HOME ) return join( env.XDG_CONFIG_HOME, `gh` )

    return join( env.HOME || homedir(), `.config`, `gh` )

}

/**
 * Check whether a gh config dir can be mounted by the active Docker daemon.
 * In nested Babysit runs the Docker daemon is outside the container, so only
 * /workspace paths can be remapped back to the original host workspace.
 * @param {string} config_dir - Host-side gh config directory candidate
 * @param {Object} [env=process.env] - Environment to inspect
 * @returns {boolean} True when the path is safe to pass as a Docker bind source
 */
export const can_mount_host_gh_config_dir = ( config_dir, env = process.env ) => {

    if( !env.BABYSIT_HOST_WORKSPACE ) return true

    return config_dir === `/workspace` || config_dir.startsWith( `/workspace/` )

}

const is_public_github_host = host => !host || host === `github.com` || host.endsWith( `.ghe.com` )

const token_key_for_host = host => is_public_github_host( host ) ? `GH_TOKEN` : `GH_ENTERPRISE_TOKEN`

const env_token_mounts = ( env = process.env ) => {

    const mounts = []

    const public_token = env.GH_TOKEN || env.GITHUB_TOKEN
    if( public_token ) mounts.push( { type: `env`, key: `GH_TOKEN`, value: public_token } )

    const enterprise_token = env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN
    if( enterprise_token ) mounts.push( { type: `env`, key: `GH_ENTERPRISE_TOKEN`, value: enterprise_token } )

    return mounts

}

/**
 * Read the active host gh token without relying on gh's on-disk storage shape.
 * On macOS and some Linux setups, `gh auth login` stores the token in a system
 * credential store rather than in hosts.yml, so a config bind alone is not
 * enough for the container.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for gh invocation
 * @returns {{ type: string, key: string, value: string }|null} Docker env mount, or null
 */
export const read_host_gh_token = ( {
    env = process.env,
    spawn_sync = spawnSync,
} = {} ) => {

    const args = [ `auth`, `token` ]
    if( env.GH_HOST ) args.push( `--hostname`, env.GH_HOST )

    const result = spawn_sync( `gh`, args, {
        encoding: `utf-8`,
        env,
        stdio: [ `ignore`, `pipe`, `ignore` ],
    } )

    if( result.error || result.status !== 0 ) return null

    const token = result.stdout.trim()
    if( !token ) return null

    return {
        type: `env`,
        key: token_key_for_host( env.GH_HOST ),
        value: token,
    }

}

/**
 * Reduce `gh auth status` JSON to credential-bearing hosts.yml content. Host
 * preferences such as aliases and git protocol never enter the generated file.
 * @param {string} status_json - Output from `gh auth status --json hosts --show-token`
 * @returns {string|null} Sanitized hosts.yml content, or null when unusable
 */
export const sanitise_host_gh_auth_status = ( status_json ) => {

    try {
        const { hosts = {} } = JSON.parse( status_json )
        const sanitised_hosts = Object.fromEntries(
            Object.entries( hosts ).map( ( [ host, entries ] ) => {

                if( !Array.isArray( entries ) ) return null

                const active_auth = entries.find( entry => entry.active && entry.token )
                if( !active_auth ) return null

                const users = Object.fromEntries(
                    entries
                        .filter( entry => entry.login && entry.token )
                        .map( entry => [ entry.login, { oauth_token: entry.token } ] )
                )

                return [ host, {
                    ... active_auth.login ? { user: active_auth.login } : {},
                    oauth_token: active_auth.token,
                    ... Object.keys( users ).length ? { users } : {},
                } ]

            } ).filter( Boolean )
        )

        return Object.keys( sanitised_hosts ).length
            ? stringify( sanitised_hosts )
            : null
    } catch {
        return null
    }

}

/**
 * Capture host gh authentication into a temporary credential-only config dir.
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for gh invocation
 * @param {Function} [options.build_tmpdir=build_tmpdir_with_files] - Test seam for temporary config
 * @returns {Array} Docker mount/env specs for a sanitized gh config
 */
export const build_sanitised_host_gh_config_mounts = ( {
    env = process.env,
    spawn_sync = spawnSync,
    build_tmpdir = build_tmpdir_with_files,
} = {} ) => {

    const result = spawn_sync( `gh`, [
        `auth`, `status`, `--json`, `hosts`, `--show-token`,
    ], {
        encoding: `utf-8`,
        env,
        stdio: [ `ignore`, `pipe`, `ignore` ],
        timeout: GH_AUTH_STATUS_TIMEOUT_MS,
    } )

    if( result.error || result.status !== 0 ) return []

    const hosts_yml = sanitise_host_gh_auth_status( result.stdout )
    if( !hosts_yml ) return []

    const config_dir = build_tmpdir( `gh`, `credentials`, {
        'config.yml': `version: 1\n`,
        'hosts.yml': hosts_yml,
    } )
    if( !config_dir ) return []

    return [
        {
            type: `volume`,
            source: config_dir,
            target: GH_CONFIG_CONTAINER_DIR,
            ro: true,
        },
        { type: `env`, key: `GH_CONFIG_DIR`, value: GH_CONFIG_CONTAINER_DIR },
    ]

}

/**
 * Build Docker mount/env specs that make the host's gh authentication usable
 * inside Babysit containers.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @param {boolean} [options.include_host_preferences=true] - Mount the host gh config directory
 * @param {Function} [options.exists_sync=existsSync] - Test seam for config dir
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for gh token lookup
 * @param {Function} [options.build_tmpdir=build_tmpdir_with_files] - Test seam for temporary config
 * @returns {Array} Docker credential mount/env specs
 */
export const setup_github_cli_credentials = ( {
    env = process.env,
    include_host_preferences = true,
    exists_sync = existsSync,
    spawn_sync = spawnSync,
    build_tmpdir = build_tmpdir_with_files,
} = {} ) => {

    const mounts = []
    const config_dir = resolve_host_gh_config_dir( env )

    if( include_host_preferences
        && exists_sync( config_dir )
        && can_mount_host_gh_config_dir( config_dir, env ) ) {
        mounts.push( {
            type: `volume`,
            source: config_dir,
            target: GH_CONFIG_CONTAINER_DIR,
            ro: true,
        } )
        mounts.push( { type: `env`, key: `GH_CONFIG_DIR`, value: GH_CONFIG_CONTAINER_DIR } )
    } else if( !include_host_preferences ) {
        mounts.push( ...build_sanitised_host_gh_config_mounts( {
            env,
            spawn_sync,
            build_tmpdir,
        } ) )
    }

    if( env.GH_HOST ) mounts.push( { type: `env`, key: `GH_HOST`, value: env.GH_HOST } )

    const direct_token_mounts = env_token_mounts( env )
    const expected_token_key = token_key_for_host( env.GH_HOST )
    const has_direct_token_for_host = direct_token_mounts.some( ( { key } ) => key === expected_token_key )
    if( has_direct_token_for_host ) return [ ...mounts, ...direct_token_mounts ]

    const has_sanitised_config = mounts.some(
        mount => mount.type === `volume` && mount.target === GH_CONFIG_CONTAINER_DIR
    )
    if( !include_host_preferences && has_sanitised_config ) {
        log.info( `GitHub CLI authentication loaded from host gh` )
        return [ ...mounts, ...direct_token_mounts ]
    }

    const token_mount = read_host_gh_token( { env, spawn_sync } )
    if( token_mount ) {
        log.info( `GitHub CLI authentication loaded from host gh` )
        mounts.push( token_mount )
    }

    return [ ...mounts, ...direct_token_mounts ]

}
