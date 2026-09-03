import { execFileSync } from 'child_process'

const read_process_command = pid => {

    try {
        return execFileSync( `ps`, [ `-ww`, `-p`, String( pid ), `-o`, `args=` ], {
            encoding: `utf8`,
            stdio: [ `ignore`, `pipe`, `ignore` ],
        } ).trim()
    } catch {
        return null
    }

}

/**
 * Verify that a persisted PID still belongs to the expected monitor launch.
 * Legacy sessions without a token retain the historical PID-only behavior.
 * @param {number|null} pid - Persisted monitor process id
 * @param {string|null} token - Per-launch monitor token
 * @param {Object} [dependencies]
 * @param {Function} [dependencies.kill=process.kill] - Signal-zero probe
 * @param {Function} [dependencies.read_command] - Process command reader
 * @returns {boolean} Whether the expected monitor process is alive
 */
export const is_monitor_alive = ( pid, token = null, {
    kill = process.kill.bind( process ),
    read_command = read_process_command,
} = {} ) => {

    if( !Number.isInteger( pid ) || pid <= 0 ) return false

    try {
        kill( pid, 0 )
    } catch {
        return false
    }

    if( !token ) return true

    const command = read_command( pid )
    if( command === null ) return true

    return command.split( /\s+/ ).includes( token )

}
