import { log } from './log.js'

const timing_enabled = env => env.BABYSIT_DEBUG === `1`

// A phase this slow deserves a line even without BABYSIT_DEBUG so the user
// learns which step held the launch instead of staring at a silent stall.
export const SLOW_PHASE_MS = 5_000

const report_phase = ( label, elapsed_ms, { env, debug, warn, slow_ms } ) => {
    if( timing_enabled( env ) ) debug( `Timing ${ label }: ${ elapsed_ms }ms` )
    else if( elapsed_ms >= slow_ms ) warn( `Slow startup phase: ${ label } took ${ ( elapsed_ms / 1_000 ).toFixed( 1 ) }s` )
}

/**
 * Measure an async startup/shutdown phase when BABYSIT_DEBUG=1.
 * @param {string} label - Stable phase name
 * @param {Function} task - Async work
 * @param {Object} [options] - Test seams; `slow_ms: Infinity` keeps a long-running or nested phase out of the slow-phase warning
 * @returns {Promise<*>} Task result
 */
export const time_phase = async ( label, task, {
    env = process.env,
    now = Date.now,
    debug = message => log.info( message ),
    warn = message => log.warn( message ),
    slow_ms = SLOW_PHASE_MS,
} = {} ) => {

    const started_at = now()
    try {
        return await task()
    } finally {
        report_phase( label, now() - started_at, { env, debug, warn, slow_ms } )
    }

}


/**
 * Measure synchronous work when BABYSIT_DEBUG=1.
 * @param {string} label - Stable phase name
 * @param {Function} task - Synchronous work
 * @param {Object} [options] - Test seams
 * @returns {*} Task result
 */
export const time_phase_sync = ( label, task, {
    env = process.env,
    now = Date.now,
    debug = message => log.info( message ),
    warn = message => log.warn( message ),
    slow_ms = SLOW_PHASE_MS,
} = {} ) => {

    const started_at = now()
    try {
        return task()
    } finally {
        report_phase( label, now() - started_at, { env, debug, warn, slow_ms } )
    }

}
