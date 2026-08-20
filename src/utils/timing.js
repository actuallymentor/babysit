import { log } from './log.js'

const timing_enabled = env => env.BABYSIT_DEBUG === `1`

/**
 * Measure an async startup/shutdown phase when BABYSIT_DEBUG=1.
 * @param {string} label - Stable phase name
 * @param {Function} task - Async work
 * @param {Object} [options] - Test seams
 * @returns {Promise<*>} Task result
 */
export const time_phase = async ( label, task, {
    env = process.env,
    now = Date.now,
    debug = message => log.info( message ),
} = {} ) => {

    if( !timing_enabled( env ) ) return task()

    const started_at = now()
    try {
        return await task()
    } finally {
        debug( `Timing ${ label }: ${ now() - started_at }ms` )
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
} = {} ) => {

    if( !timing_enabled( env ) ) return task()

    const started_at = now()
    try {
        return task()
    } finally {
        debug( `Timing ${ label }: ${ now() - started_at }ms` )
    }

}
