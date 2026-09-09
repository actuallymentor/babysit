import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

const MAX_RECORD_BYTES = 1_024 * 1_024
const MAX_TEXT_BYTES = 256 * 1_024
const POLL_INTERVAL_MS = 2_000
const READ_TIMEOUT_MS = 5_000
const LAUNCH_ID = /^[a-f0-9-]{36}$/

// Read through Docker's API, not a host bind mount. A bounded descriptor read
// avoids following symlinks, blocking on FIFOs, or trusting a file's size alone.
export const READ_COMPLETION = `
const fs = require('fs')
const [path, limit] = process.argv.slice(1)
let fd
try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > Number(limit)) process.exitCode = 1
    else {
        const buffer = Buffer.alloc(Number(limit) + 1)
        let size = 0
        while (size < buffer.length) {
            const count = fs.readSync(fd, buffer, size, buffer.length - size, null)
            if (!count) break
            size += count
        }
        if (size <= Number(limit)) process.stdout.write(buffer.subarray(0, size).toString('base64'))
    }
} catch { process.exitCode = 1 }
finally { if (fd !== undefined) fs.closeSync(fd) }
`

const identifier = value => typeof value === `string` && value.length > 0 && value.length <= 256

/**
 * Poll one launch's completed reply without blocking the monitor heartbeat.
 * Old launches without capture metadata remain empty until resumed.
 * @param {Object} session - Stored Babysit launch metadata
 * @param {Object} [options] - Command runner and clock seams
 * @param {Function} [options.run_command=run] - Async process runner
 * @param {Function} [options.now_fn=Date.now] - Millisecond clock
 * @returns {{read: Function, close: Function}} Cached completion reader
 */
export const create_completion_reader = ( session, {
    run_command = run,
    now_fn = Date.now,
} = {} ) => {

    const capture = session?.completion_capture
    const enabled = LAUNCH_ID.test( capture?.launch_id || `` )
        && capture.file === `/tmp/.babysit-completion-${ capture.launch_id }/message.json`
        && typeof session.container_id === `string` && /^[a-f0-9]{12,64}$/.test( session.container_id )
    const [ command, ...prefix ] = docker_command_prefix()
    let latest = null
    let next_poll_at = 0
    let pending = null
    let closed = false
    const controller = new AbortController()

    const poll = async () => {

        try {
            const output = await run_command( command, [
                ...prefix, `exec`, session.container_id, `node`, `-e`, READ_COMPLETION,
                capture.file, String( MAX_RECORD_BYTES ),
            ], { signal: controller.signal }, READ_TIMEOUT_MS )
            // ASCII transport avoids corrupting multibyte reply text when the
            // process runner receives stdout in the middle of a UTF-8 sequence.
            if( closed || output.length > 4 * Math.ceil( MAX_RECORD_BYTES / 3 ) ) return
            const bytes = Buffer.from( output, `base64` )
            if( bytes.length > MAX_RECORD_BYTES ) return

            const record = JSON.parse( bytes.toString( `utf8` ) )
            if( record?.version !== 1 || record.launch_id !== capture.launch_id || record.agent !== session.agent ) return
            if( !identifier( record.session_id ) || !identifier( record.turn_id ) ) return
            if( typeof record.text !== `string` || !record.text.trim() || Buffer.byteLength( record.text ) > MAX_TEXT_BYTES ) return
            if( typeof record.completed_at !== `string` || !Number.isFinite( Date.parse( record.completed_at ) ) ) return
            if( latest && Date.parse( record.completed_at ) < Date.parse( latest.completed_at ) ) return
            if( latest?.session_id === record.session_id && latest.turn_id === record.turn_id
                && latest.text === record.text && latest.completed_at === record.completed_at ) return

            // The producer checks the root CLI identity. Native sessions can
            // legitimately change within this launch after /clear or /new.
            latest = record
        } catch {
            // Missing files are normal before the first completion and while
            // older containers lack the capture hooks. Keep the previous reply.
            log.debug( `Completed reply unavailable for ${ session.babysit_id }` )
        }

    }

    return {
        read() {
            if( !closed && enabled && !pending && now_fn() >= next_poll_at ) {
                next_poll_at = now_fn() + POLL_INTERVAL_MS
                pending = poll().finally( () => {
                    pending = null
                } )
            }
            return latest
        },
        close() {
            closed = true
            controller.abort()
        },
    }

}
