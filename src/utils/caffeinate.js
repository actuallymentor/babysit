import { spawn } from 'child_process'

import { log } from './log.js'

/**
 * Build the macOS caffeinate args for a Babysit monitor process.
 * `-w <pid>` ties the assertion to the monitor's lifetime so macOS drops it
 * automatically even if Babysit exits before explicit cleanup runs.
 *
 * @param {number} pid - Process id whose lifetime should hold the assertion
 * @returns {string[]} Caffeinate CLI args
 */
export const caffeinate_args = ( pid = process.pid ) => [
    `-d`,
    `-i`,
    `-m`,
    `-s`,
    `-u`,
    `-w`,
    String( pid ),
]

/**
 * Start macOS caffeinate while a Babysit monitor is active.
 * No-ops on non-macOS hosts.
 *
 * @param {Object} [options]
 * @param {string} [options.platform=process.platform] - Host platform override for tests
 * @param {number} [options.pid=process.pid] - PID caffeinate should watch
 * @param {Function} [options.spawn_fn=spawn] - Spawn implementation override for tests
 * @returns {import('child_process').ChildProcess|null}
 */
export const start_caffeinate = ( { platform = process.platform, pid = process.pid, spawn_fn = spawn } = {} ) => {

    if( platform !== `darwin` ) return null

    try {

        const child = spawn_fn( `caffeinate`, caffeinate_args( pid ), { stdio: `ignore` } )

        child.on?.( `error`, e => {
            log.debug( `Could not start caffeinate: ${ e.message }` )
        } )

        child.unref?.()
        log.debug( `Caffeinate started for monitor pid ${ pid }${ child.pid ? ` (pid ${ child.pid })` : `` }` )

        return child

    } catch ( e ) {
        log.debug( `Could not start caffeinate: ${ e.message }` )
        return null
    }

}

/**
 * Stop a caffeinate child process if Babysit reaches normal cleanup first.
 * The `-w <pid>` guard is still the primary fail-safe for abnormal exits.
 *
 * @param {import('child_process').ChildProcess|null} child - Caffeinate child process
 */
export const stop_caffeinate = ( child ) => {

    if( !child || child.killed ) return

    try {
        child.kill()
    } catch ( e ) {
        log.debug( `Could not stop caffeinate: ${ e.message }` )
    }

}
