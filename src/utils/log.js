import { log as mentie_log } from 'mentie'

let live_log_line = null

/**
 * Keep diagnostics separate from a live terminal line such as a spinner.
 * The returned disposer only removes its own registration.
 *
 * @param {Object} line - Live terminal line controls
 * @param {Function} line.clear - Clear the live line before logging
 * @param {Function} line.render - Restore the live line after logging
 * @returns {Function} Registration disposer
 */
export const register_live_log_line = line => {

    live_log_line = line

    return () => {
        if( live_log_line === line ) live_log_line = null
    }

}

const wrap_log_method = method => ( ...messages ) => {

    const current_line = live_log_line
    current_line?.clear()

    try {
        return method( ...messages )
    } finally {
        if( live_log_line === current_line ) current_line?.render()
    }

}

/**
 * Make BABYSIT_DEBUG=1 reveal info diagnostics unless the user chose an
 * explicit Mentie log level.
 * @param {Object} [env=process.env] - Environment map
 * @returns {void}
 */
export const enable_babysit_debug_logging = ( env = process.env ) => {

    if( env.BABYSIT_DEBUG === `1` && !env.LOG_LEVEL && !env.LOGLEVEL ) {
        env.LOG_LEVEL = `info`
    }

}

enable_babysit_debug_logging()

// Wrap Mentie once so every Babysit diagnostic respects active terminal UI.
mentie_log.prefix = `babysit`

/**
 * Log through Mentie while respecting any active terminal progress line.
 * @param {...any} messages - Values to log
 * @returns {void}
 */
export const log = wrap_log_method( mentie_log )
log.insane = wrap_log_method( mentie_log.insane )
log.debug = wrap_log_method( mentie_log.debug )
log.info = wrap_log_method( mentie_log.info )
log.warn = wrap_log_method( mentie_log.warn )
log.error = wrap_log_method( mentie_log.error )
log.loglevel = mentie_log.loglevel
log.prefix = mentie_log.prefix

/**
 * Print a user-facing CLI error without mentie's developer stack trace.
 * @param {string} message - Error message to print
 */
export const print_error = ( message ) => {

    process.stderr.write( `Error: ${ message }\n` )

}
