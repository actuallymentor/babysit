import { heartbeat_label } from '../../modules/freshness.js'

/** Labels bridge freshness without implying when an agent reply was completed. */
export function Heartbeat( { updated_at } ) {
    return <span title={ updated_at || undefined }>{ heartbeat_label( updated_at ) }</span>
}
