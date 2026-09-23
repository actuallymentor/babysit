import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { control_store } from './control-store.mjs'

const describe = record => {
    if( record.status === `failed` ) throw new Error( record.message )
    if( record.status === `applied` ) return record.message
    return `Pending ${ record.operation } request (${ record.id }): ${ record.message } Timeout: 60s. Check: babysit ${ record.operation } --status ${ record.id }`
}

/** Queue native terminal controls without waiting on the calling agent's turn. */
export async function terminal_request( operation, { value, target, status_id } = {} ) {
    const launch_id = process.env.BABYSIT_CONTROL_ID
    if( status_id ) return describe( control_store( { action: `status`, launch_id, id: status_id } ) )
    const id = randomUUID()
    control_store( { action: `enqueue`, launch_id, id, operation, value, target, session_id: process.env.BABYSIT_EFFORT_SESSION_ID } )
    // Return promptly to a tool caller. The host can finish an owned dialog
    // independently after this shell returns, including mid-turn requests.
    const deadline = Date.now() + ( value === undefined ? 8_000 : 2_000 )
    let record
    do {
        await delay( 100 )
        record = control_store( { action: `status`, launch_id, id } )
        if( [ `applied`, `failed` ].includes( record.status ) ) break
    } while( Date.now() < deadline )
    return describe( record )
}
