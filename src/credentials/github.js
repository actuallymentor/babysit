import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { log } from '../utils/log.js'

export const GH_CONFIG_CONTAINER_DIR = `/home/node/.config/gh`

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
 * Build Docker mount/env specs that make the host's gh authentication usable
 * inside Babysit containers.
 *
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @param {Function} [options.exists_sync=existsSync] - Test seam for config dir
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for gh token lookup
 * @returns {Array} Docker credential mount/env specs
 */
export const setup_github_cli_credentials = ( {
    env = process.env,
    exists_sync = existsSync,
    spawn_sync = spawnSync,
} = {} ) => {

    const mounts = []
    const config_dir = resolve_host_gh_config_dir( env )

    if( exists_sync( config_dir ) ) {
        mounts.push( {
            type: `volume`,
            source: config_dir,
            target: GH_CONFIG_CONTAINER_DIR,
            ro: true,
        } )
        mounts.push( { type: `env`, key: `GH_CONFIG_DIR`, value: GH_CONFIG_CONTAINER_DIR } )
    }

    if( env.GH_HOST ) mounts.push( { type: `env`, key: `GH_HOST`, value: env.GH_HOST } )

    const direct_token_mounts = env_token_mounts( env )
    const expected_token_key = token_key_for_host( env.GH_HOST )
    const has_direct_token_for_host = direct_token_mounts.some( ( { key } ) => key === expected_token_key )
    if( has_direct_token_for_host ) return [ ...mounts, ...direct_token_mounts ]

    const token_mount = read_host_gh_token( { env, spawn_sync } )
    if( token_mount ) {
        log.info( `GitHub CLI authentication loaded from host gh` )
        mounts.push( token_mount )
    }

    return [ ...mounts, ...direct_token_mounts ]

}
