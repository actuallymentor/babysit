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
