import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
export const CONTROL_TIMEOUT_MS = 60_000
const MAX_BYTES = 128 * 1_024
const control_directory = env => join( env.BABYSIT_CONTROL_TEST_ROOT || `/tmp`, `.babysit-control-${ env.BABYSIT_CONTROL_ID }` )

/** Read bounded regular records only; control files are writable by the agent. */
const read_record = path => {
    const fd = openSync( path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK )
    try {
        const stat = fstatSync( fd )
        if( !stat.isFile() || stat.size > MAX_BYTES ) throw new Error( `Invalid control record` )
        const buffer = Buffer.alloc( MAX_BYTES + 1 )
        const length = readSync( fd, buffer, 0, buffer.length, 0 )
        if( length > MAX_BYTES ) throw new Error( `Control record too large` )
        return JSON.parse( buffer.subarray( 0, length ).toString( `utf8` ) )
    } finally {
        closeSync( fd )
    }
}

/** Native OpenCode selection precedes its next user-message model record. */
export const read_control_selection = ( { session_id, after = 0 }, env = process.env ) => {
    if( !UUID.test( env.BABYSIT_CONTROL_ID || `` ) || !session_id ) return null
    try {
        const record = read_record( join( control_directory( env ), `selection.json` ) )
        return record.launch_id === env.BABYSIT_CONTROL_ID && record.session_id === session_id && record.completed_at > after ? record.target : null
    } catch {
        return null
    }
}

/** Container-local queue, accessed by the host through Docker's API. */
export function control_store( input, env = process.env ) {
    const launch_id = env.BABYSIT_CONTROL_ID
    if( !UUID.test( launch_id || `` ) || input.launch_id !== launch_id ) throw new Error( `Control launch is unavailable or stale; start a new managed session.` )
    const directory = control_directory( env )
    mkdirSync( directory, { recursive: true, mode: 0o700 } )
    const file = id => {
        if( !UUID.test( id || `` ) ) throw new Error( `Invalid control request id` )
        return join( directory, `${ id }.json` )
    }
    const write = record => {
        const destination = file( record.id )
        const temporary = `${ destination }.${ process.pid }.tmp`
        writeFileSync( temporary, JSON.stringify( record ), { mode: 0o600 } )
        renameSync( temporary, destination )
        return record
    }
    if( input.action === `enqueue` ) {
        if( ![ `model`, `effort` ].includes( input.operation ) ) throw new Error( `Invalid control operation` )
        if( input.value !== undefined && ( typeof input.value !== `string` || !/^[^\x00-\x1f\x7f-\x9f]{1,160}$/.test( input.value ) ) ) throw new Error( `Invalid control value` )
        const record = {
            id: input.id, launch_id, operation: input.operation, value: input.value,
            target: input.target, session_id: input.session_id, created_at: Date.now(), expires_at: Date.now() + CONTROL_TIMEOUT_MS,
            status: `pending`, message: `Waiting for a safe terminal state.`,
        }
        if( Buffer.byteLength( JSON.stringify( record ) ) > MAX_BYTES ) throw new Error( `Control request too large` )
        // Exclusive publication prevents a retry from replacing a prior result.
        writeFileSync( file( record.id ), JSON.stringify( record ), { flag: `wx`, mode: 0o600 } )
        return record
    }
    if( input.action === `status` ) {
        const record = read_record( file( input.id ) )
        if( record.launch_id !== launch_id ) throw new Error( `Stale control request` )
        if( [ `pending`, `processing` ].includes( record.status ) && record.expires_at <= Date.now() ) return write( { ...record, status: `failed`, message: record.status === `pending`
            ? `Timed out waiting for a safe terminal state; no change applied.`
            : `Timed out awaiting confirmation. Inspect the current setting before retrying.` } )
        return record
    }
    if( input.action === `result` ) {
        const record = read_record( file( input.id ) )
        if( ![ `pending`, `applied`, `failed` ].includes( input.status ) ) throw new Error( `Invalid control result` )
        if( [ `applied`, `failed` ].includes( record.status ) ) return record
        if( record.expires_at <= Date.now() ) return write( { ...record, status: `failed`, message: `Timed out awaiting confirmation. Inspect the current setting before retrying.` } )
        const result = { ...record, status: input.status, message: String( input.message ).slice( 0, 32_768 ), completed_at: Date.now() }
        if( input.status === `applied` && record.operation === `model` && record.target && record.session_id ) {
            const temporary = join( directory, `selection.${ process.pid }.tmp` )
            writeFileSync( temporary, JSON.stringify( result ), { mode: 0o600 } )
            renameSync( temporary, join( directory, `selection.json` ) )
        }
        return write( result )
    }
    if( input.action === `take` ) {
        // Submission order matters when a model change precedes an effort change.
        // Completed results must not hide new work behind a fixed scan cutoff.
        const records = readdirSync( directory ).filter( entry => UUID.test( entry.slice( 0, -5 ) ) && entry.endsWith( `.json` ) ).flatMap( entry => {
            try {
                return [ read_record( join( directory, entry ) ) ]
            } catch {
                return []
            }
        } ).sort( ( a, b ) => a.created_at - b.created_at )
        const finished = records.filter( record => [ `applied`, `failed` ].includes( record.status ) )
        finished.slice( 0, Math.max( 0, finished.length - 100 ) ).forEach( record => rmSync( file( record.id ), { force: true } ) )
        for( const record of records ) {
            if( record.launch_id !== launch_id || record.status !== `pending` ) continue
            if( ![ `model`, `effort` ].includes( record.operation ) || !Number.isFinite( record.created_at ) ) continue
            const expires_at = Math.min( record.expires_at, record.created_at + CONTROL_TIMEOUT_MS )
            if( !Number.isFinite( expires_at ) || expires_at <= Date.now() ) {
                write( { ...record, status: `failed`, message: `Timed out waiting for a safe terminal state; no change applied.` } )
                continue
            }
            return { ...write( { ...record, expires_at, status: `processing` } ), remaining_ms: expires_at - Date.now() }
        }
        return null
    }
    throw new Error( `Unknown control store operation` )
}
