import { spawn } from 'node:child_process'
import { connect_rpc } from './rpc.mjs'

const capture_path = `/home/node/.babysit-capture/capture.py`

const final_text = items => {
    const messages = items.filter( item => item.type === `agentMessage` && item.delivery !== `async` && typeof item.text === `string` && item.text.trim() )
    return messages.findLast( item => item.phase === `final_answer` )?.text
        || messages.findLast( item => item.phase == null )?.text
}

/** Forward native app-server completions to the existing capture/notify chain. */
export const observe_completions = async ( endpoint, { env = process.env, args = [] } = {} ) => {

    const roots = new Map()
    const joined = new Set()
    const active = new Set()
    const delivered = new Set()
    const children = new Set()
    let rpc
    let notify
    let accepting = true
    let initialized = false
    const notifications = []
    let queue = Promise.resolve()
    let warned = false

    const warn = error => {
        if( warned ) return
        warned = true
        process.stderr.write( `babysit: Codex completion capture failed: ${ error.message }\n` )
    }

    const root_thread = async thread_id => {
        if( roots.has( thread_id ) ) return roots.get( thread_id )
        const { thread } = await rpc.request( `thread/read`, { threadId: thread_id, includeTurns: false } )
        const root = !thread.parentThreadId && [ `cli`, `vscode` ].includes( thread.source ) ? thread : null
        roots.set( thread_id, root )
        return root
    }

    const join = async thread_id => {
        if( joined.has( thread_id ) || !await root_thread( thread_id ) ) return
        await rpc.request( `thread/resume`, { threadId: thread_id, excludeTurns: true } )
        joined.add( thread_id )
    }

    const kill = child => {
        try {
            process.kill( -child.pid, `SIGKILL` )
        } catch { /* The helper may already have exited. */ }
    }

    const execute = ( command, read_output = false ) => new Promise( ( resolve, reject ) => {
        const child = spawn( command[ 0 ], command.slice( 1 ), {
            env: { ...env, BABYSIT_COMPLETION_ROOT_PID: String( process.pid ) },
            stdio: [ `ignore`, read_output ? `pipe` : `ignore`, `ignore` ],
            detached: true,
        } )
        children.add( child )
        let output = ``
        child.stdout?.on( `data`, chunk => {
            output += chunk
            if( output.length > 65_536 ) kill( child )
        } )
        const timeout = setTimeout( () => kill( child ), 5_000 )
        child.once( `error`, reject )
        child.once( `close`, code => {
            children.delete( child )
            clearTimeout( timeout )
            if( code === 0 ) resolve( output )
            else reject( new Error( `Completion helper exited with status ${ code }.` ) )
        } )
    } )

    const invoke = payload => execute( [ ...notify, JSON.stringify( payload ) ] )

    const capture = async ( thread_id, turn ) => {
        if( turn.status !== `completed` || delivered.has( `${ thread_id }/${ turn.id }` ) ) return
        const thread = await root_thread( thread_id )
        if( !thread ) return

        let items = turn.items || []
        if( turn.itemsView !== `full` ) {
            items = []
            let cursor
            do {
                const page = await rpc.request( `thread/items/list`, { threadId: thread_id, turnId: turn.id, sortDirection: `asc`, limit: 100, cursor } )
                items.push( ...page.data.filter( entry => entry.turnId === turn.id ).map( entry => entry.item ) )
                cursor = page.nextCursor
            } while( cursor )
        }
        const text = final_text( items )
        if( !text ) return
        await invoke( { type: `agent-turn-complete`, 'thread-id': thread_id, 'turn-id': turn.id, cwd: thread.cwd, 'last-assistant-message': text } )
        delivered.add( `${ thread_id }/${ turn.id }` )
    }

    const handle = async ( { method, params } ) => {
        const thread_id = params?.threadId
        if( !thread_id ) return
        if( method === `turn/completed` ) return capture( thread_id, params.turn )
        if( method !== `thread/status/changed` ) return
        if( params.status.type === `active` ) return join( thread_id )
        if( params.status.type !== `idle` || !active.has( thread_id ) || !await root_thread( thread_id ) ) return

        // A short turn can finish before our subscription. Global idle still
        // arrives; fetch its complete final answer instead of losing the event.
        const page = await rpc.request( `thread/turns/list`, { threadId: thread_id, limit: 1, sortDirection: `desc`, itemsView: `full` } )
        if( page.data[ 0 ] ) await capture( thread_id, page.data[ 0 ] )
    }

    const enqueue = message => {
        if( message.method === `thread/status/changed` && message.params?.status?.type === `active` ) active.add( message.params.threadId )
        queue = queue.then( () => handle( message ) ).catch( warn )
    }

    try {
        rpc = await connect_rpc( endpoint, {
            timeout_ms: 3_000,
            on_notification: message => {
                if( !accepting || ![ `thread/status/changed`, `turn/completed` ].includes( message.method ) ) return
                if( initialized ) enqueue( message )
                else notifications.push( message )
            },
        } )
        // config/read omits CLI notify overrides. Reuse the capture helper's
        // parser so file settings and passthrough callbacks retain one meaning.
        const encoded = await execute( [ `python3`, capture_path, `notify-command`, JSON.stringify( args ) ], true )
        let previous
        try {
            previous = JSON.parse( encoded )
        } catch {
            throw new Error( `Could not resolve the configured Codex completion callback.` )
        }
        if( !Array.isArray( previous ) || !previous.every( value => typeof value === `string` ) ) {
            throw new Error( `The configured Codex completion callback must be a command array.` )
        }
        notify = [ `python3`, capture_path, `codex`, JSON.stringify( previous ) ]

        // Joining existing root sessions supplies future turn events, but an
        // idle historical turn must never become a new completion on resume.
        let cursor
        do {
            const page = await rpc.request( `thread/loaded/list`, { cursor, limit: 100 } )
            for( const thread_id of page.data ) await join( thread_id )
            cursor = page.nextCursor
        } while( cursor )
        initialized = true
        for( const message of notifications ) enqueue( message )
        notifications.length = 0
    } catch ( error ) {
        accepting = false
        rpc?.close()
        throw error
    }

    return {
        close: async () => {
            accepting = false
            let timeout
            await Promise.race( [ queue, new Promise( resolve => {
                timeout = setTimeout( resolve, 3_000 )
            } ) ] )
            clearTimeout( timeout )
            rpc.close()
            for( const child of children ) kill( child )
        },
    }

}
