import { wait } from 'mentie'
import { load_session, update_session } from './store.js'
import { RECOVERY_PROMPT } from './recovery.js'
import { get_session_pane } from '../tmux/session.js'
import { send_text } from '../tmux/send.js'

/**
 * Submit once per recovery attempt, before monitor rules/web input can run.
 * A crash after the durable sending marker requires manual reconciliation.
 */
export const continue_recovered_session = async ( session, {
    ready,
    read_identity,
    load = load_session,
    update = update_session,
    pane = get_session_pane,
    send = send_text,
} ) => {

    if( session.continuation !== `pending` ) return session.continuation
    try {
        if( !await ready( session.tmux_session ) ) throw new Error( `Agent input did not become ready` )
        const identity = await read_identity()
        if( identity && identity.session_id !== ( session.recovery_native_id || session.agent_session_id ) ) {
            throw new Error( `Resumed conversation differs from the saved conversation` )
        }
        const current = load( session.babysit_id )
        if( !current?.expected_open || current.monitor_token !== session.monitor_token || current.continuation !== `pending` ) return current?.continuation
        const target = await pane( session.tmux_session )
        if( target.pane_id !== session.pane_id ) throw new Error( `Recovery pane identity changed` )
        const claimed = update( session.babysit_id, latest => latest.expected_open
            && latest.monitor_token === session.monitor_token && latest.continuation === `pending`
            ? { continuation: `sending` } : null )
        if( !claimed ) return load( session.babysit_id )?.continuation
        await send( target.pane_id, RECOVERY_PROMPT )
        update( session.babysit_id, { continuation: `sent`, continued_at: new Date().toISOString() } )
        return `sent`
    } catch ( error ) {
        // Preserve a concurrent --no-continue acknowledgement or a newer
        // monitor's ownership even when an awaited readiness/pane call fails.
        update( session.babysit_id, latest => {
            if( !latest.expected_open || latest.monitor_token !== session.monitor_token
                || ![ `pending`, `sending` ].includes( latest.continuation ) ) return null
            return { continuation: latest.continuation === `sending` ? `sending` : `blocked`, recovery_error: error.message }
        } )
        return load( session.babysit_id )?.continuation
    }

}

/** Wait for the detached monitor's recovery handoff without attaching a terminal. */
export const wait_for_continuation = async ( id, { timeout_ms = 90_000, load = load_session, wait_fn = wait } = {} ) => {

    const deadline = Date.now() + timeout_ms
    while( Date.now() < deadline ) {
        const session = load( id )
        if( !session || ![ `pending`, `sending` ].includes( session.continuation ) ) return session
        await wait_fn( 250 )
    }
    return load( id )

}
