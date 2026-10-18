import { randomBytes } from 'crypto'
import { existsSync, readFileSync } from 'fs'

import { hash_web_token, write_private_json } from './init.js'
import { WEB_BRIDGE_DIR, WEB_BRIDGE_PROTOCOL, web_bridge_paths } from './paths.js'

const KEY_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

// The prefix makes leaked keys greppable and tells them apart from the browser token
const KEY_PREFIX = `bsk_`

/**
 * Stored API keys: name, hash and creation time, never the key itself.
 * @param {string} [directory=WEB_BRIDGE_DIR] - Bridge root
 * @returns {{ name: string, token_sha256: string, created_at: string }[]}
 */
export const list_api_keys = ( directory = WEB_BRIDGE_DIR ) => {

    const { api_keys } = web_bridge_paths( directory )
    if( !existsSync( api_keys ) ) return []

    return JSON.parse( readFileSync( api_keys, `utf8` ) ).keys || []

}

const save_api_keys = ( directory, keys ) => {

    const paths = web_bridge_paths( directory )
    if( !existsSync( paths.access_dir ) ) throw new Error( `No web bridge yet; run babysit web init first` )

    write_private_json( paths.api_keys, { protocol: WEB_BRIDGE_PROTOCOL, keys } )

}

/**
 * Mint a read-only API key for babysit-web.
 * @param {string} name - Label, unique per bridge
 * @param {Object} [options]
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 * @param {Function} [options.random_bytes=randomBytes] - Entropy seam for tests
 * @param {Function} [options.now_fn=Date.now] - Clock seam for tests
 * @returns {string} The plaintext key, shown once
 */
export const add_api_key = ( name, {
    directory = WEB_BRIDGE_DIR,
    random_bytes = randomBytes,
    now_fn = Date.now,
} = {} ) => {

    if( !KEY_NAME_PATTERN.test( name || `` ) ) throw new Error( `API key name must be 1-64 letters, digits, dots, dashes or underscores` )

    const keys = list_api_keys( directory )
    if( keys.some( key => key.name === name ) ) throw new Error( `API key ${ name } already exists; remove it first` )

    const token = `${ KEY_PREFIX }${ random_bytes( 32 ).toString( `base64url` ) }`
    save_api_keys( directory, [ ...keys, { name, token_sha256: hash_web_token( token ), created_at: new Date( now_fn() ).toISOString() } ] )
    return token

}

/**
 * Revoke an API key; the server re-reads the file per request, so it stops at once.
 * @param {string} name - Key label
 * @param {Object} [options]
 * @param {string} [options.directory=WEB_BRIDGE_DIR] - Bridge root
 */
export const remove_api_key = ( name, { directory = WEB_BRIDGE_DIR } = {} ) => {

    const keys = list_api_keys( directory )
    if( !keys.some( key => key.name === name ) ) throw new Error( `No API key named ${ name }` )

    save_api_keys( directory, keys.filter( key => key.name !== name ) )

}
