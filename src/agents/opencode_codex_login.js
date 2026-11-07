import { readFileSync } from 'fs'

import { get_host_codex_auth_file } from './codex.js'
import { expand_home_path } from '../credentials/paths.js'

/*
 * OpenCode can use a ChatGPT subscription (its `openai` provider, "ChatGPT
 * Pro/Plus" login). Babysit lends it the Codex login so one `codex login`
 * covers both CLIs.
 *
 * Only the access token is lent, never the refresh token: ChatGPT refresh
 * tokens are single-use, so if OpenCode refreshed it would log Codex out
 * (gotcha 41). OpenCode uses the access token until it expires; whenever
 * Codex refreshes, the next sync tick hands OpenCode the new one.
 *
 * The lent entry carries a marker and is stripped before anything is written
 * back to the host's OpenCode auth.json. An OpenCode login of its own wins.
 */

// Marks the entry Babysit derived, so it never reaches the host file
export const LENT_MARKER = `babysit_lent_from`

/**
 * Expiry of a JWT in epoch ms, or null. The payload is read, not verified:
 * it only decides when OpenCode stops trying the token.
 * @param {string} token - JWT
 * @returns {number|null}
 */
const jwt_expiry_ms = token => {
    try {
        const { exp } = JSON.parse( Buffer.from( token.split( `.` )[ 1 ], `base64url` ).toString( `utf8` ) )
        return Number.isFinite( exp ) ? exp * 1000 : null
    } catch {
        return null
    }
}

/**
 * OpenCode's `openai` auth entry derived from a Codex ChatGPT login. Pure.
 * @param {string|null} codex_content - Codex auth.json text
 * @returns {Object|null} Entry, or null when Codex has no ChatGPT login
 */
export const lent_openai_entry = codex_content => {

    let codex = null
    try {
        codex = JSON.parse( codex_content || `null` )
    } catch {
        return null
    }

    // API-key Codex logins are not subscriptions; OpenCode reads keys from its own env
    const { access_token, account_id } = codex?.tokens || {}
    if( typeof access_token !== `string` || !access_token ) return null
    const expires = jwt_expiry_ms( access_token )
    if( !expires ) return null

    return { type: `oauth`, refresh: ``, access: access_token, expires, ...account_id && { accountId: account_id }, [ LENT_MARKER ]: `codex` }

}

/**
 * The container's view of the host OpenCode auth.json: the host entries plus
 * the lent Codex login, unless OpenCode has an `openai` login of its own. Pure.
 * @param {string|null} host_content - Host OpenCode auth.json text (null = absent)
 * @param {string|null} codex_content - Host Codex auth.json text
 * @returns {string|null} JSON text, or the host text untouched when nothing is lent
 */
export const compose_opencode_auth = ( host_content, codex_content ) => {

    let host = {}
    if( host_content ) {
        try {
            host = JSON.parse( host_content )
        } catch {
            // Partial host write: pass it through, the sync retries it
            return host_content
        }
    }
    if( !host || typeof host !== `object` || Array.isArray( host ) ) return host_content

    const own = host.openai && !host.openai[ LENT_MARKER ]
    const lent = own ? null : lent_openai_entry( codex_content )
    if( !lent ) return host_content

    return `${ JSON.stringify( { ...host, openai: lent }, null, 2 ) }\n`

}

/**
 * Remove the lent entry before a container change is written to the host. Pure.
 * @param {string} content - Container OpenCode auth.json text
 * @returns {string} Host text
 */
export const strip_lent_logins = content => {

    let auth = null
    try {
        auth = JSON.parse( content )
    } catch {
        return content
    }
    if( !auth?.openai?.[ LENT_MARKER ] ) return content

    const { openai, ...rest } = auth
    return `${ JSON.stringify( rest, null, 2 ) }\n`

}

/**
 * Read the host Codex login for composing; missing or unreadable is null.
 * @returns {string|null}
 */
export const read_host_codex_login = () => {
    try {
        return readFileSync( expand_home_path( get_host_codex_auth_file() ), `utf8` )
    } catch {
        return null
    }
}
