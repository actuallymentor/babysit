import { homedir } from 'os'

/**
 * Expand a leading `~` in credential paths.
 * @param {string} path - Host path that may start with ~
 * @returns {string} Expanded host path
 */
export const expand_home_path = ( path ) => path.replace( /^~(?=$|\/)/, process.env.HOME || homedir() )

/**
 * Resolve a credential file declaration. Agent adapters may provide either a
 * static path or a function that reads live environment variables.
 *
 * @param {string|(() => string)} file - Static path or resolver
 * @returns {string} Expanded host path
 */
export const resolve_credential_file = ( file ) => {

    const resolved = typeof file === `function` ? file() : file
    return expand_home_path( resolved )

}

const host_platform = () => process.platform === `darwin` ? `darwin` : `linux`

/**
 * An adapter's ordered host credential sources for one platform: the first
 * one that yields a login is staged. `{ keychain, account? }` reads the macOS
 * Keychain, `{ file }` a host file (static path or resolver).
 * @param {Object} agent - Agent adapter
 * @param {'darwin'|'linux'} [platform] - Host platform
 * @returns {Object[]} Sources, possibly empty
 */
export const credential_sources = ( agent, platform = host_platform() ) => agent?.credentials?.sources?.[ platform ] || []

/**
 * Environment variables that carry an adapter's login (key, then fallback).
 * @param {Object} agent - Agent adapter
 * @returns {string[]} Variable names
 */
export const credential_env_keys = agent => [ agent?.credentials?.env_key, agent?.credentials?.fallback_env ].filter( Boolean )
