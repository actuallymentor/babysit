import { spawn, execSync } from 'child_process'
import { log } from './log.js'

/**
 * Run a command and return its stdout as a string
 * @param {string} cmd - The command to run
 * @param {string[]} args - Command arguments
 * @param {Object} [options] - spawn options
 * @param {number} [timeout_ms=30000] - Timeout in milliseconds
 * @returns {Promise<string>} stdout output
 */
export const run = ( cmd, args = [], options = {}, timeout_ms = 30_000 ) => {

    return new Promise( ( resolve, reject ) => {

        const child = spawn( cmd, args, { stdio: [ `ignore`, `pipe`, `pipe` ], ...options } )
        let stdout = ``
        let stderr = ``
        let settled = false
        let timed_out = false
        let spawn_error = null
        let timeout = null
        let kill_timeout = null
        const abort_signal = options.signal

        const terminate_child = signal => {
            if( options.detached && child.pid && process.platform !== `win32` ) {
                try {
                    process.kill( -child.pid, signal )
                    return
                } catch {
                    // The process may already have left its group; fall back.
                }
            }

            child.kill( signal )
        }

        const schedule_kill = () => {
            clearTimeout( kill_timeout )
            kill_timeout = setTimeout( () => terminate_child( `SIGKILL` ), 1_500 )
            kill_timeout.unref?.()
        }

        const handle_abort = () => {
            terminate_child( `SIGTERM` )
            schedule_kill()
        }

        const settle = callback => {
            if( settled ) return

            settled = true
            clearTimeout( timeout )
            clearTimeout( kill_timeout )
            abort_signal?.removeEventListener( `abort`, handle_abort )
            callback()
        }

        timeout = setTimeout( () => {
            timed_out = true
            terminate_child( `SIGTERM` )
            schedule_kill()
        }, timeout_ms )
        timeout.unref?.()

        abort_signal?.addEventListener( `abort`, handle_abort, { once: true } )
        if( abort_signal?.aborted ) handle_abort()

        child.stdout.on( `data`, chunk => {
            stdout += chunk.toString()
        } )
        child.stderr.on( `data`, chunk => {
            stderr += chunk.toString()
        } )

        child.on( `close`, code => {
            settle( () => {
                if( timed_out ) {
                    const error = new Error( `${ cmd } timed out after ${ timeout_ms }ms` )
                    error.code = `ETIMEDOUT`
                    reject( error )
                } else if( spawn_error ) reject( spawn_error )
                else if( code === 0 ) resolve( stdout.trim() )
                else reject( new Error( `${ cmd } exited with code ${ code }: ${ stderr.trim() }` ) )
            } )
        } )

        // `AbortSignal` emits `error` before the child has necessarily closed.
        // Record it and settle on `close` so launch cleanup cannot race a still-
        // running Docker client. Spawn failures also emit `close` afterward.
        child.on( `error`, error => {
            spawn_error = error
        } )

    } )

}

/**
 * Run a command synchronously, returning stdout or null on failure
 * @param {string} cmd - Full command string
 * @param {Object} [options]
 * @param {number} [options.timeout_ms] - Optional wall-clock bound
 * @returns {string|null} stdout or null if command failed
 */
export const run_sync = ( cmd, { timeout_ms = undefined } = {} ) => {

    try {
        return execSync( cmd, {
            encoding: `utf-8`,
            stdio: [ `ignore`, `pipe`, `ignore` ],
            timeout: timeout_ms,
        } ).trim()
    } catch {
        return null
    }

}

/**
 * Check if a command exists on PATH
 * @param {string} cmd - The command name
 * @returns {boolean}
 */
export const command_exists = ( cmd ) => {

    return run_sync( `command -v ${ cmd }` ) !== null

}

/**
 * Spawn a detached background process
 * @param {string} cmd - The command to run
 * @param {string[]} args - Command arguments
 * @param {Object} [options] - spawn options
 * @returns {import('child_process').ChildProcess}
 */
export const spawn_detached = ( cmd, args = [], options = {} ) => {

    const child = spawn( cmd, args, {
        detached: true,
        stdio: `ignore`,
        ...options,
    } )

    child.unref()
    log.debug( `Spawned detached process ${ cmd } (pid: ${ child.pid })` )

    return child

}
