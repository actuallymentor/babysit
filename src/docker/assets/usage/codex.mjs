import { spawn } from 'node:child_process'
import { connect_rpc } from '../effort/rpc.mjs'

/** Query the native auth owner when available; no model turn or inference is started. */
export const read_codex_limits = async ( { env = process.env, spawn_process = spawn, connect = connect_rpc, timeout_ms = 15000 } = {} ) => {

    if( env.BABYSIT_EFFORT_AGENT === `codex` && env.BABYSIT_EFFORT_ENDPOINT ) {
        let rpc
        try {
            rpc = await connect( env.BABYSIT_EFFORT_ENDPOINT, { timeout_ms } )
            return await rpc.request( `account/rateLimits/read`, {} )
        } catch {
            // Native errors may echo account details or authorization headers.
            throw new Error( `Codex could not retrieve account limits; check codex login status` )
        } finally {
            rpc?.close()
        }
    }

    return new Promise( ( resolve, reject ) => {
        const child = spawn_process( `codex`, [ `app-server`, `--stdio` ], { env, stdio: [ `pipe`, `pipe`, `ignore` ] } )
        let buffer = ``
        let complete = false
        let timer
        const finish = ( error, value ) => {
            if( complete ) return
            complete = true
            clearTimeout( timer )
            child.stdin.end()
            child.kill()
            const kill_timer = setTimeout( () => child.kill( `SIGKILL` ), 1000 )
            kill_timer.unref()
            child.once( `close`, () => clearTimeout( kill_timer ) )
            if( error ) reject( error )
            else resolve( value )
        }
        timer = setTimeout( () => finish( new Error( `Codex usage query timed out` ) ), timeout_ms )
        const send = message => child.stdin.write( `${ JSON.stringify( message ) }\n` )
        child.on( `error`, () => finish( new Error( `Codex CLI unavailable` ) ) )
        child.stdin.on( `error`, () => finish( new Error( `Codex usage connection closed` ) ) )
        child.on( `exit`, () => finish( new Error( `Codex usage process exited before replying` ) ) )
        child.stdout.on( `data`, chunk => {
            buffer += chunk
            if( buffer.length > 4 * 1024 * 1024 ) return finish( new Error( `Codex usage response too large` ) )
            while( buffer.includes( `\n` ) ) {
                const end = buffer.indexOf( `\n` )
                const line = buffer.slice( 0, end )
                buffer = buffer.slice( end + 1 )
                let message
                try {
                    message = JSON.parse( line )
                } catch {
                    continue
                }
                // Upstream errors can embed account data. Keep diagnostics categorical.
                if( message.error && [ 1, 2, 3 ].includes( message.id ) ) return finish( new Error( `Codex could not retrieve account limits; check codex login status` ) )
                if( message.id === 1 ) {
                    send( { method: `initialized` } )
                    send( { id: 2, method: `account/read`, params: { refreshToken: false } } )
                }
                if( message.id === 2 ) {
                    if( !message.result?.account ) return finish( null, null )
                    if( message.result.account.type !== `chatgpt` ) return finish( null, { unsupported: true } )
                    send( { id: 3, method: `account/rateLimits/read` } )
                }
                if( message.id === 3 ) finish( null, message.result )
            }
        } )
        send( { id: 1, method: `initialize`, params: { clientInfo: { name: `babysit_usage`, version: `1` } } } )
    } )

}
