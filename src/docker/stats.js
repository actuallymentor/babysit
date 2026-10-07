import { run } from '../utils/exec.js'
import { update_session } from '../sessions/store.js'
import { docker_command_prefix } from './run.js'

const STATS_FORMAT = `{{.CPUPerc}}\t{{.MemUsage}}`
const UNIT_BYTES = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }
const MIB = 1024 ** 2
const GIB = 1024 ** 3

export const USAGE_SAMPLE_INTERVAL_MS = 30_000
// A cached sample older than this belongs to a container that is gone or a monitor that died.
export const USAGE_MAX_AGE_MS = 5 * 60_000

/**
 * Parse a Docker memory figure such as "334.8MiB" into bytes.
 * @param {string} text - Docker memory text
 * @returns {number|null} Bytes, or null when unreadable
 */
export const parse_memory = text => {

    const match = String( text ).trim().match( /^([\d.]+)\s*([a-zA-Z]+)$/ )
    const unit = match && UNIT_BYTES[ match[2].toLowerCase() ]
    return unit ? Math.round( Number( match[1] ) * unit ) : null

}

/**
 * Format bytes for the session table: whole MiB, whole GiB from 10 GiB up.
 * @param {number} bytes - Memory in bytes
 * @returns {string} e.g. "334 MiB" or "12 GiB"
 */
export const format_memory = bytes => bytes >= 10 * GIB
    ? `${ Math.round( bytes / GIB ) } GiB`
    : `${ Math.round( bytes / MIB ) } MiB`

/**
 * Format a CPU percentage with one decimal.
 * @param {number} percent - CPU percent
 * @returns {string}
 */
export const format_cpu = percent => `${ percent.toFixed( 1 ) }%`

/**
 * Docker reports CPU per core (400% = four cores flat out). Express it as a
 * share of the whole host when the sampler recorded the core count.
 * @param {{ cpu_percent: number, host_cpus?: number|null }} usage - Cached sample
 * @returns {number} Percent of total host CPU, or the raw figure without a core count
 */
export const host_cpu_percent = ( { cpu_percent, host_cpus = null } ) =>
    host_cpus > 0 ? cpu_percent / host_cpus : cpu_percent

/**
 * Parse one `docker stats --no-stream` row for a single container.
 * @param {string} output - "<cpu%>\t<used> / <limit>"
 * @returns {{ cpu_percent: number, memory_bytes: number }|null}
 */
export const parse_usage_row = output => {

    const [ cpu = ``, memory = `` ] = String( output ).trim().split( `\t` )
    const cpu_percent = Number.parseFloat( cpu )
    const [ used = `` ] = memory.split( `/` )
    const memory_bytes = parse_memory( used )
    if( !Number.isFinite( cpu_percent ) || memory_bytes === null ) return null

    return { cpu_percent, memory_bytes }

}

/**
 * Sample one container's CPU and memory with a single Docker call.
 * @param {string} container - Container id or name
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @param {number} [options.timeout_ms=10000] - Docker call timeout
 * @returns {Promise<{ cpu_percent: number, memory_bytes: number }|null>} Null when the container is gone
 */
export const sample_container_usage = async ( container, {
    run_command = run,
    command_prefix = docker_command_prefix(),
    timeout_ms = 10_000,
} = {} ) => {

    const [ command, ...prefix_args ] = command_prefix

    try {
        const output = await run_command( command, [ ...prefix_args, `stats`, `--no-stream`, `--format`, STATS_FORMAT, container ], {}, timeout_ms )
        return parse_usage_row( output )
    } catch {
        return null
    }

}

/**
 * Read the Docker host's capacity so totals can be judged against it. Docker
 * Desktop runs in a VM, so the daemon's figures matter, not the client's.
 * @param {Object} [options]
 * @param {Function} [options.run_command] - Command runner seam
 * @param {string[]} [options.command_prefix] - Docker executable and optional sudo prefix
 * @returns {Promise<{ cpus: number, memory_bytes: number }|null>}
 */
export const docker_host_capacity = async ( {
    run_command = run,
    command_prefix = docker_command_prefix(),
} = {} ) => {

    const [ command, ...prefix_args ] = command_prefix

    try {
        const output = await run_command( command, [ ...prefix_args, `info`, `--format`, `{{.NCPU}} {{.MemTotal}}` ], {}, 15_000 )
        const [ cpus, memory_bytes ] = String( output ).trim().split( /\s+/ ).map( Number )
        return cpus > 0 && memory_bytes > 0 ? { cpus, memory_bytes } : null
    } catch {
        return null
    }

}

/**
 * Keep a session record's cached `usage` fresh while its container runs.
 * `babysit list` reads the cache instead of calling Docker, so listing stays
 * instant however many containers the daemon hosts.
 * @param {Object} session - Session identity
 * @param {string} session.babysit_id - Session record id
 * @param {string} session.container_id - Running container
 * @param {Object} [options]
 * @param {number} [options.interval_ms] - Sample spacing
 * @param {Function} [options.sample] - Container usage sampler seam
 * @param {Function} [options.capacity] - Host capacity reader seam
 * @param {Function} [options.update] - Session record writer seam
 * @param {Function} [options.now] - Clock seam
 * @returns {{ stop: Function, tick: Function }} Sampler controls
 */
export const start_usage_sampler = ( { babysit_id, container_id }, {
    interval_ms = USAGE_SAMPLE_INTERVAL_MS,
    sample = sample_container_usage,
    capacity = docker_host_capacity,
    update = update_session,
    now = () => Date.now(),
} = {} ) => {

    let host = null
    let host_checked_at = -Infinity
    let in_flight = null
    let stopped = false

    const tick = async () => {
        if( in_flight ) return in_flight
        in_flight = ( async () => {
            try {
                // Capacity rarely changes; retry a failed read no more than every ten minutes.
                if( !host && now() - host_checked_at >= 10 * 60_000 ) {
                    host_checked_at = now()
                    host = await capacity()
                }
                const usage = await sample( container_id )
                if( !usage || stopped ) return
                // Skip a tick rather than block the monitor loop behind the record lock.
                update( babysit_id, { usage: {
                    ...usage,
                    sampled_at: new Date( now() ).toISOString(),
                    host_cpus: host?.cpus ?? null,
                    host_memory_bytes: host?.memory_bytes ?? null,
                } }, { wait_ms: 0 } )
            } catch {
                // Usage is decoration; never let a sampling error touch the monitor.
            } finally {
                in_flight = null
            }
        } )()
        return in_flight
    }

    const timer = setInterval( tick, interval_ms )
    timer.unref?.()
    tick()

    // Stop waits for a sample in progress so nothing writes during teardown.
    const stop = async () => {
        stopped = true
        clearInterval( timer )
        await in_flight
    }

    return { tick, stop }

}

/**
 * Usage cached on a session record, or null when absent or stale.
 * @param {Object} [session] - Stored session metadata
 * @param {number} [now] - Epoch milliseconds
 * @returns {Object|null} `usage` with numeric fields
 */
export const cached_usage = ( session = {}, now = Date.now() ) => {

    const usage = session?.usage
    if( !usage || !Number.isFinite( usage.cpu_percent ) || !Number.isFinite( usage.memory_bytes ) ) return null
    const age = now - Date.parse( usage.sampled_at || `` )
    return Number.isFinite( age ) && age <= USAGE_MAX_AGE_MS ? usage : null

}
