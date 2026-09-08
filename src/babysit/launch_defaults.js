import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { BABYSIT_DIR } from '../utils/paths.js'

const DEFAULTS_PATH = join( BABYSIT_DIR, `launch-defaults.json` )
const MODES = [ `regular`, `sandbox`, `mudbox` ]

const project_key = cwd => {
    try {
        return realpathSync( cwd )
    } catch {
        return resolve( cwd )
    }
}

const read_store = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) ) || {}
    } catch {
        return {}
    }
}

const normalise = ( value = {} ) => {

    const mode = MODES.includes( value?.mode ) ? value.mode : `regular`
    return {
        agent: SUPPORTED_AGENTS.includes( value?.agent ) ? value.agent : SUPPORTED_AGENTS[0],
        docker: value?.docker === true,
        yolo: value?.yolo === true,
        clone: mode === `regular` && value?.clone === true,
        loop: value?.loop === true,
        mode,
    }

}

/**
 * Read this workspace's last menu selection, falling back to the global choice.
 * @param {Object} [options] - Workspace and optional state-file override
 * @returns {Object} Validated menu defaults; session names are never remembered
 */
export const read_launch_defaults = ( { cwd = process.cwd(), defaults_path = DEFAULTS_PATH } = {} ) => {
    const store = read_store( defaults_path )
    return normalise( store.projects?.[ project_key( cwd ) ] ?? store.global )
}

/**
 * Remember a submitted menu launch locally and as the fallback for new projects.
 * @param {Object} cmd - Parsed start command
 * @param {Object} [options] - Workspace and optional state-file override
 */
export const save_launch_defaults = ( cmd, { cwd = process.cwd(), defaults_path = DEFAULTS_PATH } = {} ) => {

    const store = read_store( defaults_path )
    const selection = normalise( {
        agent: cmd.agent,
        ...cmd.flags,
        mode: cmd.flags.sandbox ? `sandbox` : cmd.flags.mudbox ? `mudbox` : `regular`,
    } )
    const projects = { ...store.projects, [ project_key( cwd ) ]: selection }

    mkdirSync( dirname( defaults_path ), { recursive: true } )
    // Atomic replacement keeps interrupted writes from corrupting saved defaults.
    const temporary_path = `${ defaults_path }.${ process.pid }.tmp`
    writeFileSync( temporary_path, `${ JSON.stringify( { global: selection, projects }, null, 2 ) }\n`, { mode: 0o600 } )
    renameSync( temporary_path, defaults_path )

}
