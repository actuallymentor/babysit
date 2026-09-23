import { docker_command_prefix } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { capture_pane } from '../tmux/capture.js'
import { send_text, send_keys } from '../tmux/send.js'
import { log } from '../utils/log.js'
import { terminal_control } from './terminal.js'

/**
 * A launch-scoped control worker. Requests stay inside Docker; the container
 * never receives the host tmux socket or arbitrary host command execution.
 */
export const create_control_bridge = ( session, {
    runner = run,
    capture = capture_pane,
    text = send_text,
    keys = send_keys,
    execute = terminal_control,
    now = Date.now,
} = {} ) => {
    const launch_id = session.control_id
    const pane = session.pane_id
    if( ![ `claude`, `opencode`, `antigravity` ].includes( session.agent ) ) return null
    if( !/^[a-f0-9-]{36}$/.test( launch_id || `` ) || !/^%\d+$/.test( pane || `` ) || !/^[a-f0-9]{12,64}$/.test( session.container_id || `` ) ) return null
    const [ command, ...prefix ] = docker_command_prefix()
    let task = null
    let closed = false
    let next_poll = 0
    let deadline = Infinity
    let revision = 0
    let failures = 0
    const store = async input => {
        const payload = Buffer.from( JSON.stringify( { ...input, launch_id } ) ).toString( `base64` )
        const output = await runner( command, [ ...prefix, `exec`, `--user`, `node`, session.container_id,
            `node`, `/opt/babysit-effort/control-store-bin.mjs`, payload,
        ], {}, 5_000 )
        if( output.length > 256 * 1_024 ) throw new Error( `Control response too large` )
        return JSON.parse( Buffer.from( output, `base64` ).toString( `utf8` ) )
    }
    const active = () => {
        if( closed ) throw new Error( `Control monitor stopped; verify the current setting before retrying.` )
        if( now() >= deadline ) throw new Error( `Control request timed out; inspect the current setting before retrying.` )
    }
    const poll = async busy => {
        let request
        try {
            const started = now()
            request = await store( { action: `take` } )
            failures = 0
            if( !request ) return
            if( ![ `model`, `effort` ].includes( request.operation ) || request.value !== undefined && ( typeof request.value !== `string` || !/^[^\x00-\x1f\x7f-\x9f]{1,160}$/.test( request.value ) ) ) throw new Error( `Invalid control request` )
            if( request.target && ( request.target.id !== request.value || typeof request.target.name !== `string` || request.target.name.length > 200 || /[\x00-\x1f\x7f-\x9f]/.test( request.target.name ) ) ) throw new Error( `Invalid model picker target` )
            const remaining = Math.min( 60_000, request.remaining_ms ) - ( now() - started )
            if( !Number.isFinite( remaining ) ) throw new Error( `Invalid control deadline` )
            deadline = now() + remaining
            active()
            if( remaining <= 1_000 ) throw new Error( `Control request timed out before applying.` )
            const result = await execute( {
                agent: session.agent, operation: request.operation,
                value: request.value, target: request.target, busy,
                timeout_ms: Math.min( 8_000, remaining - 1_000 ),
                capture: async () => {
                    active(); return capture( pane )
                },
                send_text: async value => {
                    active(); return text( pane, value )
                },
                send_keys: async ( ...values ) => {
                    active(); return keys( pane, ...values )
                },
            } )
            revision++
            await store( { action: `result`, id: request.id, status: `applied`, message: result.message } )
        } catch ( error ) {
            if( request ) {
                const pending = !closed && error.code === `CONTROL_PENDING` && deadline > now()
                if( !pending ) revision++
                await store( { action: `result`, id: request.id, status: pending ? `pending` : `failed`, message: error.message } ).catch( () => {} )
            } else {
                failures++
                next_poll = now() + Math.min( 60_000, 2_000 * 2 ** Math.min( failures, 5 ) )
                log.debug( `Control poll unavailable: ${ error.message }` )
            }
        }
    }
    return {
        get revision() {
            return revision
        },
        get busy() {
            return !!task
        },
        tick( { blocked = false, busy = false } = {} ) {
            if( closed || blocked || task || now() < next_poll ) return
            next_poll = now() + 2_000
            task = poll( busy ).finally( () => {
                // Leave monitor ticks for rules/web input even when Docker is slow.
                next_poll = Math.max( next_poll, now() + 2_000 )
                task = null
            } )
        },
        async close() {
            closed = true
            await task
        },
    }
}
