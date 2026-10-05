import { run } from '../utils/exec.js'
import { docker_command_prefix } from './run.js'

const STATS_FORMAT = `{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}`

/**
 * Parse `docker stats --no-stream --no-trunc` rows into per-container usage.
 * The memory column is "used / limit"; only the used part is kept.
 * @param {string} output - Tab-separated stats rows
 * @returns {Array<{ id: string, name: string, cpu: string, memory: string }>}
 */
export const parse_container_stats = ( output = `` ) => String( output )
    .split( `\n` )
    .filter( Boolean )
    .map( row => {
        const [ id = ``, name = ``, cpu = ``, memory = `` ] = row.split( `\t` )
        const [ used = `` ] = memory.split( `/` )
        return { id: id.trim(), name: name.trim(), cpu: cpu.trim(), memory: used.trim() }
    } )
    .filter( ( { id } ) => id )

/**
 * Sample CPU and memory usage of every running container in one Docker call.
 * Naming targets would fail the whole call when a stored id no longer exists,
 * so sample everything and let callers pick their rows. Failures (no daemon,
 * no Docker) resolve to an empty list so listings degrade to "-". The sample
 * itself takes ~1s; the short deadline keeps a sluggish daemon from holding
 * the listing hostage, since usage is optional decoration.
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @param {number} [options.timeout_ms=4000] - Docker call timeout
 * @returns {Promise<Array<{ id: string, name: string, cpu: string, memory: string }>>}
 */
export const container_stats = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
    timeout_ms = 4_000,
} = {} ) => {

    const [ command, ...prefix_args ] = command_prefix

    try {
        const output = await run_command(
            command,
            [ ...prefix_args, `stats`, `--no-stream`, `--no-trunc`, `--format`, STATS_FORMAT ],
            {},
            timeout_ms
        )
        return parse_container_stats( output )
    } catch {
        return []
    }

}

/**
 * Find the usage sample for a session's container by id or name.
 * Stored ids may be full 64-hex while a sample row carries the same or a
 * truncated id, so match by prefix in either direction. Older records lack
 * container_name; Docker names Babysit containers after the Babysit id.
 * @param {Array<{ id: string, name: string }>} stats - Sampled usage rows
 * @param {Object} [session] - Stored session metadata
 * @param {string|null} [session.container_id]
 * @param {string|null} [session.container_name]
 * @param {string|null} [session.babysit_id]
 * @returns {{ cpu: string, memory: string }|null}
 */
export const stats_for_session = ( stats = [], { container_id = null, container_name = null, babysit_id = null } = {} ) => {

    const expected_name = container_name || ( babysit_id ? `babysit-${ babysit_id }` : null )
    const same_id = ( left, right ) => Boolean( left && right && ( left.startsWith( right ) || right.startsWith( left ) ) )
    const same_name = name => Boolean( expected_name ) && name === expected_name

    return stats.find( ( { id, name } ) => same_id( id, container_id ) || same_name( name ) ) || null

}
