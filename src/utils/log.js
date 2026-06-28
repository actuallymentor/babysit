import { log as mentie_log } from 'mentie'

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
