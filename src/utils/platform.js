import { is_mac, is_linux } from 'mentie'
import os from 'os'

/**
 * Detect the current platform
 * @returns {'darwin'|'linux'} The current platform identifier
 */
export const detect_platform = () => {

    if( is_mac ) return `darwin`
    if( is_linux ) return `linux`

    // Fallback to os.platform()
    const platform = os.platform()
    if( platform === `darwin` ) return `darwin`
    return `linux`

}

/**
 * Get the current CPU architecture
 * @returns {'x64'|'arm64'} The current architecture
 */
export const detect_arch = () => {

    const arch = os.arch()
    if( arch === `arm64` || arch === `aarch64` ) return `arm64`
    return `x64`

}

/**
 * Whether this process runs inside a babysit agent container. Keys off
 * BABYSIT_MODIFIERS, which build_docker_command sets on every launch (the
 * statusline reads it). A babysit-specific env var beats `/.dockerenv`,
 * which is also true when babysit itself runs in an unrelated container.
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @returns {boolean} True inside a babysit container
 */
export const is_babysit_container = ( { env = process.env } = {} ) => Boolean( env.BABYSIT_MODIFIERS )

/**
 * Where babysit runs: inside one of its agent containers, or on the host
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @returns {'host'|'container'} The runtime mode
 */
export const detect_mode = ( { env = process.env } = {} ) => is_babysit_container( { env } ) ? `container` : `host`
