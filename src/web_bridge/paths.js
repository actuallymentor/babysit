import { join } from 'path'

import { BABYSIT_DIR } from '../utils/paths.js'

export const WEB_BRIDGE_PROTOCOL = 1
export const WEB_BRIDGE_DIR = process.env.BABYSIT_WEB_BRIDGE_DIR
    || join( BABYSIT_DIR, `web-bridge` )

/**
 * Resolve every filesystem capability used by the web bridge.
 * @param {string} [root=WEB_BRIDGE_DIR] - Bridge root override
 * @returns {{ root: string, access_dir: string, access: string, state: string, requests: string, inflight: string }}
 */
export const web_bridge_paths = ( root = WEB_BRIDGE_DIR ) => ( {
    root,
    access_dir: join( root, `access` ),
    access: join( root, `access`, `access.json` ),
    state: join( root, `state` ),
    requests: join( root, `requests` ),
    inflight: join( root, `inflight` ),
} )
