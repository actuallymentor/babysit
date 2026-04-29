import { existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { log } from '../utils/log.js'

// Signals that indicate a Node.js project. `bun.lock` (text) is the format used
// by Bun 1.2+; `bun.lockb` is the legacy binary form. Detect both.
const NODE_SIGNALS = [ `package.json`, `node_modules`, `.nvmrc`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lock`, `bun.lockb` ]

// Signals that indicate a Python project
const PYTHON_SIGNALS = [ `requirements.txt`, `pyproject.toml`, `Pipfile`, `setup.py`, `.venv`, `venv` ]

/**
 * Detect dependency folders that should be isolated with docker volumes
 * @param {string} workspace - Host workspace directory
 * @returns {Array<{ host_path: string, container_path: string, volume_name: string }>} Volume mount specs
 */
export const detect_dependency_volumes = ( workspace ) => {

    const volumes = []
    const path_hash = createHash( `sha256` ).update( workspace ).digest( `hex` ).slice( 0, 12 )

    // Node.js: isolate node_modules
    const has_node = NODE_SIGNALS.some( signal => existsSync( join( workspace, signal ) ) )
    if( has_node ) {
        volumes.push( {
            host_path: join( workspace, `node_modules` ),
            container_path: `/workspace/node_modules`,
            volume_name: `babysit-nm-${ path_hash }`,
            env_key: `BABYSIT_NM_ISOLATED`,
        } )
        log.debug( `Node.js project detected, isolating node_modules` )
    }

    // Python: isolate .venv
    const has_python = PYTHON_SIGNALS.some( signal => existsSync( join( workspace, signal ) ) )
    if( has_python ) {
        volumes.push( {
            host_path: join( workspace, `.venv` ),
            container_path: `/workspace/.venv`,
            volume_name: `babysit-venv-${ path_hash }`,
            env_key: `BABYSIT_VENV_ISOLATED`,
        } )
        log.debug( `Python project detected, isolating .venv` )
    }

    return volumes

}
