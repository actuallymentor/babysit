import { resolve } from 'node:path'

const positive_integer = ( value, fallback ) => {
    const number = Number.parseInt( value, 10 )
    return Number.isSafeInteger( number ) && number > 0 ? number : fallback
}

const configured_origin = value => {
    if( !value ) return null

    const url = new URL( value )
    if( ![ `http:`, `https:` ].includes( url.protocol ) || url.origin !== value.replace( /\/$/, `` ) ) throw new Error( `BABYSIT_WEB_PUBLIC_ORIGIN must be an HTTP origin without a path` )

    return url
}

/**
 * Resolves and validates server configuration.
 * @param {NodeJS.ProcessEnv} environment - Environment variables to read
 * @returns {Object} Validated server configuration
 */
export const read_config = ( environment=process.env ) => ( {
    access_file: resolve( environment.BABYSIT_WEB_ACCESS_FILE || `/bridge/access.json` ),
    allow_insecure_http: environment.BABYSIT_WEB_ALLOW_INSECURE_HTTP === `1`,
    heartbeat_ttl_ms: positive_integer( environment.BABYSIT_WEB_HEARTBEAT_TTL_MS, 15_000 ),
    login_limit: positive_integer( environment.BABYSIT_WEB_LOGIN_LIMIT, 8 ),
    login_window_ms: positive_integer( environment.BABYSIT_WEB_LOGIN_WINDOW_MS, 60_000 ),
    port: positive_integer( environment.PORT, 3_000 ),
    public_origin: configured_origin( environment.BABYSIT_WEB_PUBLIC_ORIGIN ),
    request_dir: resolve( environment.BABYSIT_WEB_REQUEST_DIR || `/bridge/requests` ),
    request_ttl_ms: positive_integer( environment.BABYSIT_WEB_REQUEST_TTL_MS, 20_000 ),
    session_ttl_ms: positive_integer( environment.BABYSIT_WEB_SESSION_TTL_MS, 43_200_000 ),
    state_dir: resolve( environment.BABYSIT_WEB_STATE_DIR || `/bridge/state` ),
    static_dir: resolve( environment.BABYSIT_WEB_STATIC_DIR || new URL( `../dist`, import.meta.url ).pathname ),
    trust_proxy: environment.BABYSIT_WEB_TRUST_PROXY === `1`,
} )
