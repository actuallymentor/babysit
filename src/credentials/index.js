import { detect_platform } from '../utils/platform.js'
import { setup_darwin_credentials } from './darwin.js'
import { setup_linux_credentials } from './linux.js'

/**
 * Set up credential passthrough for an agent, choosing the right platform adapter
 * @param {Object} agent - Agent adapter
 * @param {Object} [options]
 * @param {string} [options.existing_tmpfile] - Re-use this tmpfile (monitor case)
 *   instead of creating a new one. The monitor MUST pass session.creds_tmpfile here
 *   so its sync watches the same tmpfile the container is mounting — otherwise the
 *   container's OAuth refreshes never get propagated back to the host file and the
 *   next babysit session fails with "refresh token already used".
 * @param {Object|null} [options.sync_baseline] - Foreground-capture hashes used
 *   when reusing an existing tmpfile in the monitor
 * @returns {Promise<{ mounts: Array, sync: Object|null, sync_baseline: Object|null }>}
 */
export const setup_credentials = async ( agent, options = {} ) => {

    const platform = detect_platform()

    if( platform === `darwin` ) return setup_darwin_credentials( agent, options )
    return setup_linux_credentials( agent, options )

}
