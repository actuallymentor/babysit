/** Connect to a session-local Codex server without taking ownership of its turns. */
export const connect_rpc = async ( endpoint, { timeout_ms = 10000, on_notification = () => {} } = {} ) => {

    const address = new URL( endpoint )
    if( address.protocol !== `ws:` || address.hostname !== `127.0.0.1` ) {
        throw new Error( `Effort control requires a loopback WebSocket endpoint` )
    }

    const socket = new WebSocket( address )
    const pending = new Map()
    let next_id = 0
    let closed = false

    const fail = error => {
        closed = true
        for( const request of pending.values() ) request.reject( error )
        pending.clear()
    }

    socket.addEventListener( `close`, () => fail( new Error( `Codex effort connection closed` ) ) )
    socket.addEventListener( `error`, () => fail( new Error( `Cannot connect to Codex effort server` ) ) )
    socket.addEventListener( `message`, event => {
        let message
        try {
            message = JSON.parse( event.data )
        } catch {
            return
        }

        // Read-only observers may consume notifications. Approval requests still
        // belong to the TUI; this client must never answer them.
        if( message.method ) {
            if( message.id === undefined ) on_notification( message )
            return
        }
        if( !pending.has( message.id ) ) return
        const request = pending.get( message.id )
        pending.delete( message.id )
        if( message.error ) request.reject( new Error( message.error.message || `Codex request failed` ) )
        else request.resolve( message.result )
    } )

    const close = () => {
        fail( new Error( `Codex effort connection closed` ) )
        socket.close()
    }

    const request = ( method, params ) => new Promise( ( resolve, reject ) => {
        if( closed ) return reject( new Error( `Codex effort connection closed` ) )
        const id = ++next_id
        const timer = setTimeout( () => {
            pending.delete( id )
            reject( new Error( `Codex ${ method } timed out; its outcome is unknown` ) )
        }, timeout_ms )
        pending.set( id, {
            resolve: value => {
                clearTimeout( timer )
                resolve( value )
            },
            reject: error => {
                clearTimeout( timer )
                reject( error )
            },
        } )
        try {
            socket.send( JSON.stringify( { jsonrpc: `2.0`, id, method, params } ) )
        } catch ( error ) {
            pending.get( id ).reject( error )
            pending.delete( id )
        }
    } )

    try {
        await new Promise( ( resolve, reject ) => {
            const timer = setTimeout( () => reject( new Error( `Codex effort connection timed out` ) ), timeout_ms )
            const finish = callback => {
                clearTimeout( timer )
                callback()
            }
            socket.addEventListener( `open`, () => finish( resolve ), { once: true } )
            socket.addEventListener( `error`, () => finish( () => reject( new Error( `Cannot connect to Codex effort server` ) ) ), { once: true } )
            socket.addEventListener( `close`, () => finish( () => reject( new Error( `Codex effort connection closed` ) ) ), { once: true } )
        } )
        await request( `initialize`, {
            clientInfo: { name: `babysit_effort`, version: `1` },
            capabilities: { experimentalApi: true },
        } )
        socket.send( JSON.stringify( { jsonrpc: `2.0`, method: `initialized` } ) )
        return { request, close }
    } catch ( error ) {
        close()
        throw error
    }

}
