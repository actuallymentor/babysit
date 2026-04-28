import { command_exists } from '../utils/exec.js'
import { log } from '../utils/log.js'

// Required dependencies and their install hints
const REQUIRED_DEPS = [
    { cmd: `docker`, name: `Docker`, hint: `https://docs.docker.com/get-docker/` },
    { cmd: `tmux`, name: `tmux`, hint: `brew install tmux (macOS) or apt install tmux (Linux)` },
    { cmd: `git`, name: `git`, hint: `brew install git (macOS) or apt install git (Linux)` },
]

/**
 * Check that all required system dependencies are installed
 * @returns {boolean} True if all deps are present
 */
export const check_dependencies = () => {

    let all_ok = true

    for( const dep of REQUIRED_DEPS ) {

        if( !command_exists( dep.cmd ) ) {
            log.error( `Missing dependency: ${ dep.name }` )
            log.error( `  Install: ${ dep.hint }` )
            all_ok = false
        }

    }

    return all_ok

}
