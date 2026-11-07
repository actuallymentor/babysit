import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'

/**
 * The live launch channel: one `docker exec` per poll reads the capture
 * directory the in-container hooks write (src/agents/completion_capture.js):
 *
 * | File            | Holds                                   | Consumer              |
 * | --------------- | --------------------------------------- | --------------------- |
 * | message.json    | last completed root reply               | web bridge            |
 * | identity.json   | root native session id                  | registry, recovery    |
 * | events.jsonl    | turn_started / turn_completed / ...     | monitor turn state    |
 *
 * Live only: the container must be running. The durable receipts that must
 * survive container loss stay in sessions/transcript.js (read_durable_receipt).
 */

const MAX_MESSAGE_BYTES = 1_024 * 1_024
const MAX_TEXT_BYTES = 256 * 1_024
const MAX_IDENTITY_BYTES = 4_096
// New event bytes per poll. A burst past it skips to the newest whole lines.
const EVENT_WINDOW_BYTES = 64 * 1_024
const MAX_OUTPUT_BYTES = 4 * Math.ceil( ( MAX_MESSAGE_BYTES + MAX_IDENTITY_BYTES + EVENT_WINDOW_BYTES ) / 3 ) + 1_024

// Poll fast while a turn is open (its end paces segments), slower otherwise,
// and back off once a launch has shown nothing for a while: an old
// container without hooks would otherwise cost one exec every few seconds.
export const FAST_POLL_MS = 2_000
export const SLOW_POLL_MS = 5_000
export const SILENT_POLL_MS = 15_000
const SILENT_AFTER_MS = 60_000
const READ_TIMEOUT_MS = 5_000

const LAUNCH_ID = /^[a-f0-9-]{36}$/
const SESSION_ID = /^[a-zA-Z0-9_-]{1,256}$/
const EVENT_TYPES = new Set( [ `session_id`, `turn_started`, `turn_completed`, `permission_prompt`, `exit` ] )

// Bounded descriptor reads: no symlinks, no FIFOs, no hard links, no trusting
// a size alone. Unchanged files (same inode/size/mtime key) come back empty,
// and events.jsonl resumes from the caller's byte offset on the same inode.
// Output is ASCII (base64 payloads): the runner may split UTF-8 chunks.
export const READ_LAUNCH_CHANNEL = `
const fs = require('fs')
const [dir, message_key, identity_key, events_ino, events_offset, message_limit, identity_limit, window] = process.argv.slice(1)
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const range = (fd, start, length) => {
    const buffer = Buffer.alloc(length)
    let size = 0
    while (size < length) {
        const count = fs.readSync(fd, buffer, size, length - size, start + size)
        if (!count) break
        size += count
    }
    return buffer.subarray(0, size)
}
const open = (name, read) => {
    let fd
    try {
        fd = fs.openSync(dir + '/' + name, flags)
        const stat = fs.fstatSync(fd)
        return stat.isFile() && stat.nlink === 1 ? read(fd, stat) : null
    } catch { return null }
    finally { if (fd !== undefined) fs.closeSync(fd) }
}
const whole = (name, limit, known) => open(name, (fd, stat) => {
    if (stat.size > limit) return null
    const key = stat.ino + ':' + stat.size + ':' + stat.mtimeMs
    if (key === known) return { key }
    const data = range(fd, 0, Number(limit) + 1)
    return data.length > limit ? null : { key, data: data.toString('base64') }
})
const events = open('events.jsonl', (fd, stat) => {
    const ino = String(stat.ino)
    let start = ino === events_ino && stat.size >= Number(events_offset) ? Number(events_offset) : 0
    const truncated = stat.size - start > Number(window)
    if (truncated) start = stat.size - Number(window)
    return { ino, start, truncated, data: range(fd, start, stat.size - start).toString('base64') }
})
process.stdout.write(JSON.stringify({
    message: whole('message.json', Number(message_limit), message_key),
    identity: whole('identity.json', Number(identity_limit), identity_key),
    events,
}))
`

const identifier = value => typeof value === `string` && value.length > 0 && value.length <= 256
const timestamp = value => typeof value === `string` && Number.isFinite( Date.parse( value ) )

/**
 * Whether stored metadata names a capture directory this channel may read.
 * Old launches without capture metadata stay disabled (pane-only).
 * @param {Object} session - Stored Babysit launch metadata
 * @returns {string|null} Container capture directory
 */
export const launch_channel_directory = session => {

    const capture = session?.completion_capture
    if( !LAUNCH_ID.test( capture?.launch_id || `` ) ) return null
    const directory = `/tmp/.babysit-completion-${ capture.launch_id }`
    if( capture.file !== `${ directory }/message.json` ) return null
    if( !/^[a-f0-9]{12,64}$/.test( session.container_id || `` ) ) return null
    return directory

}

/**
 * Validate one events.jsonl line against this launch.
 * @param {string} line - Raw JSON line
 * @param {Object} session - Launch metadata
 * @returns {Object|null} Event, or null when malformed or foreign
 */
export const parse_launch_event = ( line, session ) => {

    try {
        const event = JSON.parse( line )
        if( event?.version !== 1 || event.launch_id !== session.completion_capture.launch_id ) return null
        if( event.agent !== session.agent || !EVENT_TYPES.has( event.type ) ) return null
        if( !Number.isSafeInteger( event.seq ) || event.seq < 1 || !timestamp( event.at ) ) return null
        if( event.session_id !== undefined && !identifier( event.session_id ) ) return null
        return event
    } catch {
        return null
    }

}

/**
 * Fold events into the current turn. `open`: started, not finished. `blocked`:
 * open but waiting on a permission prompt. `closed`: the newest boundary was a
 * completion (or exit). Null: no turn boundary seen. Claude fires no hook on
 * an Escape interrupt (2.1.318), so `open` can be stale; consumers decide
 * staleness from the pane (see babysit/activity.js combine_status).
 * @param {Object|null} turn - Previous state
 * @param {Object} event - Validated event
 * @returns {Object|null} Next state
 */
export const next_turn_state = ( turn, event ) => {

    const at = Date.parse( event.at )
    switch ( event.type ) {
    case `turn_started`:
        return { state: `open`, turn_id: event.turn_id || null, status: null, at, seq: event.seq, started_seq: event.seq }
    case `permission_prompt`:
        return turn?.state === `open` ? { ...turn, state: `blocked`, at, seq: event.seq } : turn
    case `turn_completed`:
        return { state: `closed`, turn_id: event.turn_id || turn?.turn_id || null, status: event.status || `completed`, at, seq: event.seq, started_seq: turn?.started_seq ?? null }
    case `exit`:
        return { state: `closed`, turn_id: turn?.turn_id || null, status: `exit`, at, seq: event.seq, started_seq: turn?.started_seq ?? null }
    default:
        return turn
    }

}

/**
 * One live reader per launch for message, identity and turn events.
 * read() never blocks: it returns cached state and starts a poll when due.
 * refresh() awaits one poll (identity before monitor spawn, recovery).
 * @param {Object} session - Stored Babysit launch metadata
 * @param {Object} [options] - Async command runner and millisecond clock seams
 * @returns {Object} Launch channel
 */
export const create_launch_channel = ( session, {
    run_command = run,
    now_fn = Date.now,
} = {} ) => {

    const directory = launch_channel_directory( session )
    const [ command, ...prefix ] = docker_command_prefix()
    const controller = new AbortController()
    const created_at = now_fn()

    let message = null
    let identity = null
    let turn = null
    let exit = null
    let message_key = ``
    let identity_key = ``
    let events_ino = ``
    let events_offset = 0
    let last_seq = 0
    let started_seen = false
    let seen_anything = false
    let pending = null
    let closed = false
    let last_poll_at = -Infinity

    const accept_message = record => {
        if( record?.version !== 1 || record.launch_id !== session.completion_capture.launch_id || record.agent !== session.agent ) return
        if( !identifier( record.session_id ) || !identifier( record.turn_id ) ) return
        if( typeof record.text !== `string` || !record.text.trim() || Buffer.byteLength( record.text ) > MAX_TEXT_BYTES ) return
        if( !timestamp( record.completed_at ) ) return
        if( message && Date.parse( record.completed_at ) < Date.parse( message.completed_at ) ) return
        if( message?.session_id === record.session_id && message.turn_id === record.turn_id
            && message.text === record.text && message.completed_at === record.completed_at ) return
        // The producer checks the root CLI. Native sessions can change
        // within one launch after /clear or /new.
        message = record
    }

    const accept_identity = record => {
        if( record?.version !== 1 || record.launch_id !== session.completion_capture.launch_id || record.agent !== session.agent ) return
        if( typeof record.session_id !== `string` || !SESSION_ID.test( record.session_id ) ) return
        if( !timestamp( record.captured_at ) ) return
        if( identity && Date.parse( record.captured_at ) < Date.parse( identity.captured_at ) ) return
        identity = record
    }

    const decode = ( part, accept ) => {
        if( !part?.data ) return
        try {
            accept( JSON.parse( Buffer.from( part.data, `base64` ).toString( `utf8` ) ) )
        } catch { /* Keep the previous record */ }
    }

    const accept_events = ( { ino, start, truncated, data } ) => {
        let bytes = Buffer.from( data, `base64` )
        let offset = start

        // A skipped window starts mid-line: drop the fragment
        if( truncated ) {
            const first = bytes.indexOf( 10 )
            if( first < 0 ) return
            offset += first + 1
            bytes = bytes.subarray( first + 1 )
        }

        // Only whole lines count; a partial tail is re-read next poll
        const last = bytes.lastIndexOf( 10 )
        if( last < 0 ) {
            events_ino = ino
            events_offset = offset
            return
        }
        for( const line of bytes.subarray( 0, last ).toString( `utf8` ).split( `\n` ) ) {
            const event = parse_launch_event( line, session )
            if( !event ) {
                if( line.trim() ) log.debug( `Ignoring malformed launch event for ${ session.babysit_id }` )
                continue
            }
            // Rotation rewrites the file under a new inode; seq never repeats
            if( event.seq <= last_seq ) continue
            last_seq = event.seq
            if( event.type === `turn_started` ) started_seen = true
            if( event.type === `exit` ) exit = event
            turn = next_turn_state( turn, event )
        }
        events_ino = ino
        events_offset = offset + last + 1
    }

    const poll = async () => {
        try {
            const output = await run_command( command, [
                ...prefix, `exec`, session.container_id, `node`, `-e`, READ_LAUNCH_CHANNEL,
                directory, message_key, identity_key, events_ino, String( events_offset ),
                String( MAX_MESSAGE_BYTES ), String( MAX_IDENTITY_BYTES ), String( EVENT_WINDOW_BYTES ),
            ], { signal: controller.signal }, READ_TIMEOUT_MS )
            if( closed || output.length > MAX_OUTPUT_BYTES ) return
            const snapshot = JSON.parse( output )

            // Each part fails alone: a bad message must not hide turn events.
            // A rejected record keeps its key: the same bytes stay rejected.
            if( snapshot.message?.key ) message_key = snapshot.message.key
            if( snapshot.identity?.key ) identity_key = snapshot.identity.key
            seen_anything ||= Boolean( snapshot.message || snapshot.identity || snapshot.events )
            decode( snapshot.message, accept_message )
            decode( snapshot.identity, accept_identity )
            if( snapshot.events ) {
                accept_events( snapshot.events )
            }
        } catch {
            // Missing files are normal before the first hook and in old
            // containers; a stopped container fails the exec. Keep state.
            log.debug( `Launch channel unavailable for ${ session.babysit_id }` )
        }
    }

    const interval = eager => {
        if( eager || turn?.state === `open` || turn?.state === `blocked` ) return FAST_POLL_MS
        if( !seen_anything && now_fn() - created_at >= SILENT_AFTER_MS ) return SILENT_POLL_MS
        return SLOW_POLL_MS
    }

    const refresh = () => {
        if( closed || !directory ) return Promise.resolve( identity )
        if( !pending ) {
            last_poll_at = now_fn()
            pending = poll().finally( () => {
                pending = null
            } )
        }
        return pending.then( () => identity )
    }

    // Poll when due; `eager` asks for the fast cadence (a turn may be running)
    const tick = ( { eager = false } = {} ) => {
        if( now_fn() - last_poll_at >= interval( eager ) ) refresh()
    }

    return {
        enabled: Boolean( directory ),
        tick,
        refresh,
        message: () => message,
        identity: () => identity,
        turn: () => turn,
        exit: () => exit,

        /** Whether this launch's producer reports turn starts (Claude, OpenCode, managed Codex) */
        reports_turns: () => started_seen,

        /** Newest event seq seen; a segment wait marks it before typing */
        last_seq: () => last_seq,

        /** Web bridge view: the last completed reply */
        completion_reader: {
            read() {
                tick()
                return message
            },
            close() {},
        },

        close() {
            closed = true
            controller.abort()
        },
    }

}
