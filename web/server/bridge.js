import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { log } from 'mentie'

const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9-]+$/
const REQUEST_FILE_PATTERN = /^[A-Za-z0-9-]+--[A-Za-z0-9-]+--[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/
const TEMPORARY_FILE_PATTERN = /^\.babysit-web-[0-9a-f-]+\.tmp$/
const MAX_STATE_BYTES = 1_048_576
const MAX_MESSAGE_BYTES = 16_384
const MAX_QUEUED_REQUESTS = 64

const state_summary = state => ( {
    activity: state.activity,
    agent: state.agent,
    attachment: state.attachment,
    busy: state.busy,
    directory: state.directory,
    epoch: state.epoch,
    modifiers: state.modifiers,
    name: state.name,
    revision: state.revision,
    session_id: state.session_id,
    updated_at: state.updated_at,
} )

const normalize_state = parsed => {
    if( parsed.protocol !== 1 || !BRIDGE_TOKEN_PATTERN.test( parsed.session_id ) || !BRIDGE_TOKEN_PATTERN.test( parsed.epoch ) ) return null

    return {
        activity: [ `idle`, `running` ].includes( parsed.activity ) ? parsed.activity : `running`,
        agent: typeof parsed.agent === `string` ? parsed.agent : `agent`,
        attachment: [ `attached`, `detached`, `unknown` ].includes( parsed.attachment ) ? parsed.attachment : `unknown`,
        busy: parsed.busy === true,
        directory: typeof parsed.directory === `string` ? parsed.directory : ``,
        epoch: parsed.epoch,
        last_message: typeof parsed.last_message === `string` ? parsed.last_message : ``,
        modifiers: Array.isArray( parsed.modifiers ) ? parsed.modifiers.filter( value => typeof value === `string` ).slice( 0, 12 ) : [],
        name: typeof parsed.name === `string` ? parsed.name : parsed.session_id,
        protocol: 1,
        raw_screen: typeof parsed.raw_screen === `string` ? parsed.raw_screen : ``,
        results: Array.isArray( parsed.results )
            ? parsed.results
                .filter( result => result && typeof result.request_id === `string` )
                .slice( -20 )
                .map( result => ( {
                    completed_at: typeof result.completed_at === `string` ? result.completed_at : null,
                    message: typeof result.message === `string` ? result.message : null,
                    request_id: result.request_id,
                    status: [ `accepted`, `rejected`, `failed` ].includes( result.status ) ? result.status : `failed`,
                } ) )
            : [],
        revision: Number.isSafeInteger( parsed.revision ) ? parsed.revision : 0,
        session_id: parsed.session_id,
        updated_at: typeof parsed.updated_at === `string` ? parsed.updated_at : null,
    }
}

const valid_message = text => {
    if( typeof text !== `string` ) throw Object.assign( new Error( `Message must be text` ), { status_code: 400 } )

    const normalized = text.replace( /\r\n?/g, `\n` )
    if( normalized.trim().length === 0 ) throw Object.assign( new Error( `Message cannot be empty` ), { status_code: 400 } )
    if( Buffer.byteLength( normalized, `utf8` ) > MAX_MESSAGE_BYTES ) throw Object.assign( new Error( `Message exceeds 16 KiB` ), { status_code: 413 } )
    if( /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test( normalized ) ) throw Object.assign( new Error( `Message contains unsupported control characters` ), { status_code: 400 } )

    return normalized
}

/** Reads fresh host-authored session snapshots from the bridge. */
export class BridgeStore {

    constructor( { heartbeat_ttl_ms, request_dir, request_ttl_ms, state_dir } ) {
        this.heartbeat_ttl_ms = heartbeat_ttl_ms
        this.request_dir = request_dir
        this.request_ttl_ms = request_ttl_ms
        this.state_dir = state_dir
        this.pending = new Map()
        this.cleanup_timer = setInterval( () => {
            try {
                this.cleanup_pending()
            } catch ( error ) {
                log.warn( `Could not clean stale bridge requests:`, error.message )
            }
        }, Math.min( request_ttl_ms, 5_000 ) )
        this.cleanup_timer.unref()
    }

    read_state_file( filename ) {
        const path = join( this.state_dir, filename )
        const details = lstatSync( path )
        if( !details.isFile() || details.size > MAX_STATE_BYTES || Date.now() - details.mtimeMs > this.heartbeat_ttl_ms ) return null

        return normalize_state( JSON.parse( readFileSync( path, `utf8` ) ) )
    }

    sessions() {
        const states = readdirSync( this.state_dir, { withFileTypes: true } )
            .filter( entry => entry.isFile() && entry.name.endsWith( `.json` ) )
            .flatMap( entry => {
                try {
                    const state = this.read_state_file( entry.name )
                    return state ? [ state ] : []
                } catch {
                    return []
                }
            } )

        return states.sort( ( first, second ) => {
            if( first.busy !== second.busy ) return first.busy ? -1 : 1
            if( first.activity !== second.activity ) return first.activity === `running` ? -1 : 1
            return first.name.localeCompare( second.name )
        } )
    }

    summaries() {
        return this.sessions().map( state_summary )
    }

    session( session_id ) {
        if( !BRIDGE_TOKEN_PATTERN.test( session_id ) ) return null
        return this.sessions().find( state => state.session_id === session_id ) || null
    }

    send( { session, text } ) {
        this.cleanup_pending()
        if( readdirSync( this.request_dir ).length >= MAX_QUEUED_REQUESTS ) {
            throw Object.assign( new Error( `Message queue is full. Try again shortly.` ), { status_code: 429 } )
        }

        const request_id = randomUUID()
        const message = valid_message( text )
        const filename = `${ session.session_id }--${ session.epoch }--${ request_id }.json`
        const request_path = join( this.request_dir, filename )
        const temporary_path = join( this.request_dir, `.babysit-web-${ request_id }.tmp` )
        const payload = {
            epoch: session.epoch,
            kind: `text`,
            protocol: 1,
            request_id,
            session_id: session.session_id,
            text: message,
        }

        let descriptor
        try {
            descriptor = openSync( temporary_path, `wx`, 0o600 )
            writeFileSync( descriptor, `${ JSON.stringify( payload ) }\n` )
            fsyncSync( descriptor )
            closeSync( descriptor )
            descriptor = null
            renameSync( temporary_path, request_path )
        } finally {
            if( descriptor !== null && descriptor !== undefined ) closeSync( descriptor )
            if( existsSync( temporary_path ) ) unlinkSync( temporary_path )
        }

        this.pending.set( request_id, {
            created_at: Date.now(),
            filename,
            request_path,
            session_id: session.session_id,
            status: `pending`,
        } )

        return { request_id, status: `pending` }
    }

    pending_for( state ) {
        this.cleanup_pending()
        const results = new Map( state.results.map( result => [ result.request_id, result ] ) )

        return [ ...this.pending.values() ]
            .filter( request => request.session_id === state.session_id )
            .map( request => {
                const result = results.get( request.request_id )
                if( result ) request.status = result.status

                if( request.status === `pending` && !existsSync( request.request_path ) ) request.status = `claimed`

                return {
                    message: result?.message,
                    request_id: request.request_id,
                    status: request.status,
                }
            } )
    }

    cleanup_pending() {
        const now = Date.now()

        this.pending.forEach( ( request, request_id ) => {
            if( request.status === `pending` && !existsSync( request.request_path ) ) request.status = `claimed`

            if( request.status === `pending` && now - request.created_at > this.request_ttl_ms ) {
                try {
                    if( basename( request.request_path ) === request.filename ) unlinkSync( request.request_path )
                } catch ( error ) {
                    if( error.code !== `ENOENT` ) log.warn( `Could not remove timed-out bridge request:`, error.message )
                }
                request.status = `timed_out`
            }

            if( request.status !== `pending` && now - request.created_at > 120_000 ) this.pending.delete( request_id )
        } )

        readdirSync( this.request_dir, { withFileTypes: true } )
            .filter( entry => entry.isFile() && ( REQUEST_FILE_PATTERN.test( entry.name ) || TEMPORARY_FILE_PATTERN.test( entry.name ) ) )
            .forEach( entry => {
                const path = join( this.request_dir, entry.name )
                const age_ms = now - lstatSync( path ).mtimeMs
                if( age_ms <= this.request_ttl_ms ) return

                try {
                    unlinkSync( path )
                } catch ( error ) {
                    if( error.code !== `ENOENT` ) log.warn( `Could not remove orphaned bridge request:`, error.message )
                }
            } )
    }
}

export { MAX_MESSAGE_BYTES }
