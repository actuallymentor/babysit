import { spawn, execSync } from 'child_process'
import { promise_timeout } from 'mentie'
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

    const task = new Promise( ( resolve, reject ) => {

        const child = spawn( cmd, args, { stdio: [ `ignore`, `pipe`, `pipe` ], ...options } )
        let stdout = ``
        let stderr = ``

        child.stdout.on( `data`, chunk => {
            stdout += chunk.toString() 
        } )
        child.stderr.on( `data`, chunk => {
            stderr += chunk.toString() 
        } )

        child.on( `close`, code => {
            if( code === 0 ) resolve( stdout.trim() )
            else reject( new Error( `${ cmd } exited with code ${ code }: ${ stderr.trim() }` ) )
        } )

        child.on( `error`, reject )

    } )

    return promise_timeout( task, timeout_ms )

}

/**
 * Run a command synchronously, returning stdout or null on failure
 * @param {string} cmd - Full command string
 * @returns {string|null} stdout or null if command failed
 */
export const run_sync = ( cmd ) => {

    try {
        return execSync( cmd, { encoding: `utf-8`, stdio: [ `ignore`, `pipe`, `ignore` ] } ).trim()
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
