/**
 * Resolve `promise`, or `fallback()` when it misses the deadline. The promise
 * keeps running, so its own side effects (refreshing a cache) still land.
 * @param {Promise} promise - Work that may stall
 * @param {number} deadline_ms - How long to wait
 * @param {Function} fallback - Value producer for a missed deadline
 * @returns {Promise<*>}
 */
export const within_deadline = ( promise, deadline_ms, fallback ) => {

    let timer = null
    const missed = new Promise( resolve => {
        timer = setTimeout( () => resolve( fallback() ), deadline_ms )
    } )
    return Promise.race( [ promise, missed ] ).finally( () => clearTimeout( timer ) )

}
