import { log as mentie_log } from 'mentie'

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

// Re-export mentie log with babysit prefix
mentie_log.prefix = `babysit`

export const log = mentie_log

/**
 * Print a user-facing CLI error without mentie's developer stack trace.
 * @param {string} message - Error message to print
 */
export const print_error = ( message ) => {

    process.stderr.write( `Error: ${ message }\n` )

}
