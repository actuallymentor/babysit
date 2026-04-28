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
