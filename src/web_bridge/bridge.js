import { randomBytes, randomUUID } from 'crypto'
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    openSync,
    opendirSync,
    readFileSync,
    readSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs'
import { join } from 'path'

import { log } from '../utils/log.js'
import { send_text } from '../tmux/send.js'
import { get_session_attachment, get_session_pane } from '../tmux/session.js'
import { WEB_BRIDGE_DIR, WEB_BRIDGE_PROTOCOL, web_bridge_paths } from './paths.js'

const MAX_TEXT_BYTES = 16 * 1_024
const MAX_REQUEST_BYTES = 24 * 1_024
const MAX_SCREEN_CHARACTERS = 65_536
const MAX_REQUESTS_PER_TICK = 8
const MAX_DIRECTORY_ENTRIES_PER_TICK = 32
const REQUEST_TTL_MS = 20_000
const MAX_RESULTS = 20
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/
const TOKEN_HASH = /^[a-f0-9]{64}$/
const UNSAFE_INPUT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const UNSAFE_DISPLAY_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu

class RejectedRequest extends Error {}

const is_safe_identifier = value => typeof value === `string` && IDENTIFIER.test( value )

const compact_directory = directory => {

    if( !directory ) return `-`

    const levels = String( directory ).split( /[\\/]+/ ).filter( Boolean )
    return levels.slice( -2 ).join( `/` ) || `-`

}

const sanitize_display_text = value => String( value || `` )
    .replace( UNSAFE_DISPLAY_TEXT, `` )
    .slice( -MAX_SCREEN_CHARACTERS )
    .trimEnd()

const private_regular_file = path => {

    try {
        const entry = lstatSync( path )
        return entry.isFile()
            && !entry.isSymbolicLink()
            && entry.nlink === 1
            && ( entry.mode & 0o077 ) === 0
    } catch {
        return false
    }

}

const private_directory = path => {

    try {
        const entry = lstatSync( path )
        return entry.isDirectory()
            && !entry.isSymbolicLink()
            && ( entry.mode & 0o077 ) === 0
    } catch {
        return false
    }

}

/**
 * Check whether `babysit web init` created a safe bridge capability.
 * @param {string} [directory=WEB_BRIDGE_DIR] - Bridge root
 * @returns {boolean} Whether monitor publishing may start
 */
export const web_bridge_initialized = ( directory = WEB_BRIDGE_DIR ) => {

    const paths = web_bridge_paths( directory )
    const directories_safe = [ paths.root, paths.state, paths.requests, paths.inflight ]
        .every( private_directory )

    if( !directories_safe || !private_regular_file( paths.access ) ) return false

    try {
        const access = JSON.parse( readFileSync( paths.access, `utf8` ) )
        return access?.protocol === WEB_BRIDGE_PROTOCOL
            && TOKEN_HASH.test( access.token_sha256 )
            && [ `read`, `write` ].includes( access.role )
    } catch {
        return false
    }

}

const write_atomic_json = ( path, value ) => {

    const pending_path = `${ path }.pending-${ process.pid }-${ randomUUID() }`

    try {
        writeFileSync( pending_path, `${ JSON.stringify( value ) }\n`, { mode: 0o600 } )
        chmodSync( pending_path, 0o600 )
        renameSync( pending_path, path )
    } finally {
        rmSync( pending_path, { force: true } )
    }

}

const request_filename = ( session_id, epoch, request_id ) =>
    `${ session_id }--${ epoch }--${ request_id }.json`

const request_id_from_filename = ( filename, session_id, epoch ) => {

    const prefix = `${ session_id }--${ epoch }--`
    if( !filename.startsWith( prefix ) || !filename.endsWith( `.json` ) ) return null

    const request_id = filename.slice( prefix.length, -`.json`.length )
    return is_safe_identifier( request_id ) && filename === request_filename( session_id, epoch, request_id )
        ? request_id
        : null

}

const read_claimed_request = ( path, now_ms ) => {

    const no_follow = constants.O_NOFOLLOW || 0
    const descriptor = openSync( path, constants.O_RDONLY | no_follow | constants.O_NONBLOCK )

    try {
        const entry = fstatSync( descriptor )

        if( !entry.isFile() || entry.nlink !== 1 ) throw new RejectedRequest( `Unsafe request file` )
        if( entry.size <= 0 || entry.size > MAX_REQUEST_BYTES ) throw new RejectedRequest( `Request is too large` )

        const age_ms = now_ms - entry.mtimeMs
        if( age_ms < -2_000 || age_ms > REQUEST_TTL_MS ) throw new RejectedRequest( `Request expired` )

        // Read at most cap+1 from the already-validated descriptor. If the file
        // changes after fstat, it still cannot make this allocation unbounded.
        const buffer = Buffer.alloc( MAX_REQUEST_BYTES + 1 )
        let bytes_read = 0

        while( bytes_read < buffer.length ) {
            const count = readSync( descriptor, buffer, bytes_read, buffer.length - bytes_read, null )
            if( count === 0 ) break
            bytes_read += count
        }

        if( bytes_read > MAX_REQUEST_BYTES ) throw new RejectedRequest( `Request is too large` )

        return JSON.parse( buffer.subarray( 0, bytes_read ).toString( `utf8` ) )
    } catch ( error ) {
        if( error instanceof RejectedRequest ) throw error
        throw new RejectedRequest( `Malformed request` )
    } finally {
        closeSync( descriptor )
    }

}

const validate_request = ( request, expected ) => {

    const required_keys = [ `protocol`, `session_id`, `epoch`, `request_id`, `screen_revision`, `kind`, `text` ]
    const allowed_keys = new Set( [ ...required_keys, `created_at` ] )
    const keys = request && typeof request === `object` && !Array.isArray( request )
        ? Object.keys( request )
        : []

    if( !required_keys.every( key => keys.includes( key ) ) || keys.some( key => !allowed_keys.has( key ) ) ) {
        throw new RejectedRequest( `Invalid request schema` )
    }
    if( request.protocol !== WEB_BRIDGE_PROTOCOL ) throw new RejectedRequest( `Unsupported protocol` )
    if( request.session_id !== expected.session_id || request.epoch !== expected.epoch ) {
        throw new RejectedRequest( `Session changed; refresh and try again` )
    }
    if( request.request_id !== expected.request_id ) throw new RejectedRequest( `Request id mismatch` )
    if( request.kind !== `text` ) throw new RejectedRequest( `Unsupported request kind` )
    if( request.created_at !== undefined && typeof request.created_at !== `string` ) {
        throw new RejectedRequest( `Invalid creation time` )
    }
    if( !Number.isSafeInteger( request.screen_revision ) || request.screen_revision < 0 ) {
        throw new RejectedRequest( `Invalid screen revision` )
    }
    if( typeof request.text !== `string` || !request.text.trim() ) throw new RejectedRequest( `Message is empty` )
    if( Buffer.byteLength( request.text, `utf8` ) > MAX_TEXT_BYTES ) throw new RejectedRequest( `Message is too large` )
    if( UNSAFE_INPUT_TEXT.test( request.text ) ) throw new RejectedRequest( `Message contains unsafe control characters` )

    return request

}

/**
 * Create a bridge bound to one immutable Babysit launch and exact tmux pane.
 * @param {Object} options
 * @param {Object} options.session - Stored Babysit session metadata
 * @param {string} options.tmux_target - Exact tmux pane id such as `%3`
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 * @param {string} [options.epoch] - Per-monitor capability epoch
 * @param {Function} [options.send_text_fn=send_text] - Input sender seam
 * @param {Function} [options.attachment_fn=get_session_attachment] - Attachment reader seam
 * @param {Function} [options.now_fn=Date.now] - Clock seam
 * @returns {Object} Monitor bridge controller
 */
export const create_web_bridge = ( {
    session,
    tmux_target,
    directory = WEB_BRIDGE_DIR,
    epoch = randomBytes( 16 ).toString( `hex` ),
    send_text_fn = send_text,
    attachment_fn = get_session_attachment,
    now_fn = Date.now,
} ) => {

    const session_id = session?.babysit_id
    if( !is_safe_identifier( session_id ) ) throw new Error( `Web bridge requires a safe session id` )
    if( !/^%\d+$/.test( tmux_target ) ) throw new Error( `Web bridge requires an exact tmux pane id` )
    if( !is_safe_identifier( epoch ) ) throw new Error( `Web bridge requires a safe launch epoch` )

    const paths = web_bridge_paths( directory )
    const state_path = join( paths.state, `${ session_id }.json` )
    const results = []
    let attachment = `unknown`
    let raw_screen = ``
    let last_message = null
    let revision = 0
    let current_activity = `running`

    const state_value = busy => ( {
        protocol: WEB_BRIDGE_PROTOCOL,
        session_id,
        epoch,
        name: typeof session.name === `string` && session.name ? sanitize_display_text( session.name ) : null,
        agent: sanitize_display_text( session.agent || `unknown` ),
        activity: busy ? `running` : current_activity,
        attachment,
        busy,
        modifiers: Array.isArray( session.modifiers )
            ? session.modifiers.filter( value => typeof value === `string` ).slice( 0, 16 ).map( sanitize_display_text )
            : [],
        directory: compact_directory( session.original_pwd || session.pwd ),
        last_message,
        raw_screen,
        revision,
        updated_at: new Date( now_fn() ).toISOString(),
        results: [ ...results ],
    } )

    const write_state = busy => write_atomic_json( state_path, state_value( busy ) )

    const add_result = ( request_id, status, message ) => {
        results.push( {
            request_id,
            status,
            message,
            completed_at: new Date( now_fn() ).toISOString(),
        } )
        if( results.length > MAX_RESULTS ) results.splice( 0, results.length - MAX_RESULTS )
    }

    return {
        epoch,
        session_id,
        tmux_target,

        /**
         * Publish the latest allowlisted pane state and heartbeat.
         * @param {Object} snapshot - Current monitor snapshot
         * @param {string} snapshot.output - ANSI-cleaned pane output
         * @param {'idle'|'running'} snapshot.activity - Agent activity
         * @param {boolean} [snapshot.busy=false] - Whether a Babysit action owns input
         */
        async publish( { output, activity, busy = false } ) {

            const next_screen = sanitize_display_text( output )
            if( next_screen !== raw_screen ) {
                raw_screen = next_screen
                revision += 1
            }
            if( activity === `idle` && raw_screen ) last_message = raw_screen
            current_activity = activity === `idle` ? `idle` : `running`

            try {
                attachment = await attachment_fn( session.tmux_session )
            } catch {
                attachment = `unknown`
            }

            write_state( busy )
        },

        /**
         * Claim and handle a bounded request batch before monitor rules run.
         * @param {Object} [options]
         * @param {boolean} [options.busy=false] - Whether a Babysit action owns input
         * @returns {Promise<{ sent: boolean, processed: number }>} Batch outcome
         */
        async process_requests( { busy = false } = {} ) {

            const candidates = []
            const request_directory = opendirSync( paths.requests )
            let entries_scanned = 0

            try {
                while(
                    entries_scanned < MAX_DIRECTORY_ENTRIES_PER_TICK
                    && candidates.length < MAX_REQUESTS_PER_TICK
                ) {
                    const entry = request_directory.readSync()
                    if( !entry ) break
                    entries_scanned += 1

                    const request_id = request_id_from_filename( entry.name, session_id, epoch )
                    if( request_id ) candidates.push( { filename: entry.name, request_id } )
                }
            } finally {
                request_directory.closeSync()
            }

            let sent = false
            let processed = 0

            for( const { filename, request_id } of candidates ) {
                const request_path = join( paths.requests, filename )
                const claimed_path = join( paths.inflight, filename )

                // The inflight directory is host-only. Checking first prevents
                // rename's overwrite semantics from replacing a prior claim.
                if( existsSync( claimed_path ) ) continue

                try {
                    renameSync( request_path, claimed_path )
                } catch {
                    continue
                }

                processed += 1

                try {
                    const request = validate_request(
                        read_claimed_request( claimed_path, now_fn() ),
                        { session_id, epoch, request_id }
                    )

                    if( busy ) throw new RejectedRequest( `Session is busy with a Babysit action` )

                    await send_text_fn( tmux_target, request.text, { redact: true } )
                    add_result( request_id, `accepted`, `Message sent` )
                    sent = true
                } catch ( error ) {
                    const rejected = error instanceof RejectedRequest
                    add_result(
                        request_id,
                        rejected ? `rejected` : `failed`,
                        rejected ? error.message : `Could not send message`
                    )
                } finally {
                    rmSync( claimed_path, { recursive: true, force: true } )
                    try {
                        write_state( busy )
                    } catch {
                        // Delivery already happened. A state write failure must
                        // not hide `sent: true` and let a rule submit again.
                        log.debug( `Could not publish web bridge request result for ${ session_id }` )
                    }
                }

                // One submitted message changes the agent state. Leave later
                // requests unclaimed until the next fresh pane capture.
                if( sent ) break
            }

            return { sent, processed }
        },

        /** Remove this monitor's published state when its session ends. */
        close() {

            try {
                const current = JSON.parse( readFileSync( state_path, `utf8` ) )
                if( current?.epoch === epoch ) rmSync( state_path, { force: true } )
            } catch ( error ) {
                if( error?.code !== `ENOENT` ) log.debug( `Could not remove web bridge state for ${ session_id }` )
            }
        },
    }

}

/**
 * Open a bridge for an active monitor when `babysit web init` enabled it.
 * @param {Object} options
 * @param {Object} options.session - Stored Babysit session metadata
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 * @param {Function} [options.resolve_pane=get_session_pane] - Exact pane resolver seam
 * @param {Object} [options.bridge_options] - Options forwarded to create_web_bridge
 * @returns {Promise<Object|null>} Controller, or null when bridge is disabled
 */
export const open_web_bridge = async ( {
    session,
    directory = WEB_BRIDGE_DIR,
    resolve_pane = get_session_pane,
    bridge_options = {},
} ) => {

    if( !web_bridge_initialized( directory ) ) return null

    try {
        const { pane_id } = await resolve_pane( session.tmux_session )
        return create_web_bridge( {
            session,
            tmux_target: pane_id,
            directory,
            ...bridge_options,
        } )
    } catch ( error ) {
        log.warn( `Could not start the web bridge for ${ session.babysit_id }: ${ error.message }` )
        return null
    }

}
