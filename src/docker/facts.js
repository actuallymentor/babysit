import { mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { BABYSIT_DIR } from '../utils/paths.js'
import { write_atomic_json } from '../web_bridge/files.js'
import { run } from '../utils/exec.js'
import { within_deadline } from '../utils/deadline.js'
import { docker_command_prefix } from './run.js'
import { get_image_name } from './update.js'

// Slow-changing Docker facts, remembered across launches. `docker info` and
// `docker image inspect` queue behind daemon-wide locks (layer removal, build
// cache GC) and were measured stalling 90-117 s; `docker version` never does.
export const DOCKER_FACTS_PATH = join( BABYSIT_DIR, `docker-facts.json` )

// The daemon ID only changes when Docker is reinstalled
const DAEMON_ID_TTL_MS = 24 * 3_600_000

// A healthy daemon answers an image inspect in well under a second
export const IMAGE_FACTS_DEADLINE_MS = 1_500

const BOOTSTRAP_GATE_LABEL = `babysit.bootstrap-gate`

// Missing or corrupt files read as an empty cache
const read_facts = ( path = DOCKER_FACTS_PATH ) => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) ) || {}
    } catch {
        return {}
    }
}

// Read-modify-write so concurrent launches only race on their own key
const write_fact = ( section, key, value, path = DOCKER_FACTS_PATH ) => {
    try {
        const facts = read_facts( path )
        facts[ section ] = { ...facts[ section ], [ key ]: value }
        mkdirSync( join( path, `..` ), { recursive: true } )
        write_atomic_json( path, facts )
    } catch {
        // A cache that cannot be written only costs the next launch a lookup
    }
}

/**
 * Which daemon the CLI talks to, from the same inputs Docker resolves.
 * @param {Object} [env=process.env] - Environment to inspect
 * @returns {string} Endpoint key for the identity cache
 */
export const docker_endpoint_key = ( env = process.env ) => {

    if( env.DOCKER_HOST ) return `host:${ env.DOCKER_HOST }`
    if( env.DOCKER_CONTEXT ) return `context:${ env.DOCKER_CONTEXT }`

    try {
        const config_dir = env.DOCKER_CONFIG || join( homedir(), `.docker` )
        const { currentContext } = JSON.parse( readFileSync( join( config_dir, `config.json` ), `utf8` ) )
        if( currentContext ) return `context:${ currentContext }`
    } catch {
        // No CLI config means the default context
    }
    return `context:default`

}

/**
 * The daemon's ID: cached for a day, else asked once via `docker info`.
 * @param {Object} [options] - Seams
 * @returns {Promise<string>} Daemon ID (empty when Docker gave none)
 */
export const cached_docker_id = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
    endpoint = docker_endpoint_key(),
    now = Date.now,
    path = DOCKER_FACTS_PATH,
    // Only answers from the real daemon are remembered; test runners stay hermetic
    remembers = run_command === run,
} = {} ) => {

    const cached = remembers ? read_facts( path ).daemons?.[ endpoint ] : null
    if( cached?.id && now() - cached.at < DAEMON_ID_TTL_MS ) return cached.id

    const [ command, ...prefix_args ] = command_prefix
    const id = String( await run_command( command, [ ...prefix_args, `info`, `--format`, `{{.ID}}` ], {}, 15_000 ) ).trim()
    if( id && remembers ) write_fact( `daemons`, endpoint, { id, at: now() }, path )
    return id

}

// One inspect per image per process, shared by every caller
const inspections = new WeakMap()

/**
 * Image ID and bootstrap-gate support from one `docker image inspect`. When
 * the daemon stalls past the deadline, the last known facts for this image
 * stand in; the inspect finishes in the background and refreshes them.
 * @param {Object} [options] - Seams
 * @returns {Promise<{ id: string|null, gate: boolean }>} Unknown image → { id: null, gate: false }
 */
export const image_facts = ( {
    run_command = run,
    image = get_image_name(),
    command_prefix = docker_command_prefix(),
    deadline_ms = IMAGE_FACTS_DEADLINE_MS,
    now = Date.now,
    path = DOCKER_FACTS_PATH,
    // Only answers from the real daemon are remembered; test runners stay hermetic
    remembers = run_command === run,
} = {} ) => {

    const per_runner = inspections.get( run_command ) || new Map()
    inspections.set( run_command, per_runner )

    if( !per_runner.has( image ) ) {

        const [ command, ...prefix_args ] = command_prefix
        const format = `{{.Id}} {{index .Config.Labels "${ BOOTSTRAP_GATE_LABEL }"}}`
        const inspection = run_command( command, [ ...prefix_args, `image`, `inspect`, image, `--format`, format ], {}, 30_000 )
            .then( output => {
                const [ id = ``, label = `` ] = String( output ).trim().split( /\s+/ )
                const facts = { id: id || null, gate: label === `1` }
                if( facts.id && remembers ) write_fact( `images`, image, { ...facts, at: now() }, path )
                return facts
            } )
            .catch( () => ( { id: null, gate: false } ) )

        per_runner.set( image, inspection )

    }

    const inspection = per_runner.get( image )
    const known = remembers ? read_facts( path ).images?.[ image ] : null
    if( !known?.id ) return inspection

    return within_deadline( inspection, deadline_ms, () => ( { id: known.id, gate: known.gate === true } ) )

}

/**
 * Drop remembered facts for an image, e.g. after pulling a new version.
 * @param {string} [image=get_image_name()] - Image reference
 * @param {string} [path=DOCKER_FACTS_PATH] - Cache path
 */
export const forget_image_facts = ( image = get_image_name(), path = DOCKER_FACTS_PATH ) => {

    const facts = read_facts( path )
    if( !facts.images?.[ image ] ) return
    delete facts.images[ image ]
    try {
        write_atomic_json( path, facts )
    } catch {
        // Stale facts are only consulted when the daemon stalls
    }

}
