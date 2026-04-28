import { detect_platform } from '../utils/platform.js'
import { setup_darwin_credentials } from './darwin.js'
import { setup_linux_credentials } from './linux.js'

/**
 * Set up credential passthrough for an agent, choosing the right platform adapter
 * @param {Object} agent - Agent adapter
 * @returns {Promise<{ mounts: Array, sync: Object|null }>}
 */
export const setup_credentials = async ( agent ) => {

    const platform = detect_platform()

    if( platform === `darwin` ) return setup_darwin_credentials( agent )
    return setup_linux_credentials( agent )

}
