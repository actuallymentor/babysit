import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { BABYSIT_DIR } from '../utils/paths.js'
import { write_atomic_json } from '../web_bridge/files.js'
import { claude_header_request } from '../docker/assets/usage/providers.mjs'
import { collect_usage } from '../docker/assets/usage/command.mjs'
import { CLAUDE_TOKEN_ENV } from './claude_token.js'

/*
 * Several Claude subscriptions, each a named `claude setup-token`. The token in
 * ~/.babysitrc stays the implicit `default` account, so single-token users
 * change nothing. Named tokens live in a 0600 registry under the state dir and
 * reach a container only as a staged file (never `docker run -e`).
 */

export const DEFAULT_ACCOUNT = `default`
export const ACCOUNTS_PATH = join( BABYSIT_DIR, `claude-accounts.json` )
export const ACCOUNT_USAGE_PATH = join( BABYSIT_DIR, `claude-account-usage.json` )

// Quota headers cost one output token per account, so launches reuse a recent read
export const ACCOUNT_USAGE_TTL_MS = 5 * 60_000

const ACCOUNT_NAME = /^[a-z0-9][a-z0-9_.-]{0,31}$/i
const YEAR_MS = 365 * 24 * 3600_000
const RC_STAMP = /^# Claude setup-token from babysit auth init, (\d{4}-\d{2}-\d{2}); expires ~(\d{4}-\d{2}-\d{2})/m

// Missing or corrupt files read as null
const read_json = path => {
    try {
        return JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        return null
    }
}

const write_private_json = ( path, value ) => {
    mkdirSync( join( path, `..` ), { recursive: true } )
    write_atomic_json( path, value )
}

// The cache never stores tokens; a hash ties each reading to the token that bought it
const token_hash = token => createHash( `sha256` ).update( token ).digest( `hex` ).slice( 0, 16 )

/**
 * Throw unless the name is a short, shell- and filename-safe word.
 * @param {string} name - Account name
 * @returns {string} The name
 */
export const validate_account_name = name => {
    if( typeof name !== `string` || !ACCOUNT_NAME.test( name ) ) throw new Error( `Account names are 1-32 letters, digits, ".", "_" or "-" (got ${ JSON.stringify( name ) })` )
    return name
}

/**
 * Read the named-token registry. Missing or corrupt files mean no accounts.
 * @param {Object} [options]
 * @param {string} [options.path] - Registry path
 * @returns {{ version: number, accounts: Object }}
 */
export const read_account_registry = ( { path = ACCOUNTS_PATH } = {} ) => {
    const parsed = read_json( path )
    return parsed?.version === 1 && parsed.accounts && typeof parsed.accounts === `object`
        ? parsed
        : { version: 1, accounts: {} }
}

/**
 * Add or replace a named setup-token. The registry is rewritten atomically at 0600.
 * @param {string} name - Account name (not `default`: that one lives in ~/.babysitrc)
 * @param {string} token - Proven setup-token
 * @param {Object} [options] - Path and clock seams
 * @returns {string} Registry path
 */
export const save_account = ( name, token, { path = ACCOUNTS_PATH, now = new Date() } = {} ) => {

    validate_account_name( name )
    if( name === DEFAULT_ACCOUNT ) throw new Error( `"${ DEFAULT_ACCOUNT }" is the ~/.babysitrc token; save it without --name` )

    const registry = read_account_registry( { path } )
    registry.accounts[ name ] = {
        token,
        added_at: now.toISOString(),
        expires_at: new Date( now.getTime() + YEAR_MS ).toISOString(),
    }
    write_private_json( path, registry )
    return path

}

/**
 * Remove a named account and its cached usage.
 * @param {string} name - Account name
 * @param {Object} [options] - Path seams
 * @returns {boolean} Whether the account existed
 */
export const remove_account = ( name, { path = ACCOUNTS_PATH, usage_path = ACCOUNT_USAGE_PATH } = {} ) => {

    const registry = read_account_registry( { path } )
    if( !registry.accounts[ name ] ) return false

    delete registry.accounts[ name ]
    write_private_json( path, registry )

    const cache = read_json( usage_path )
    if( cache?.[ name ] ) {
        delete cache[ name ]
        write_private_json( usage_path, cache )
    }
    return true

}

/**
 * Every usable account: the rc token as `default` first, then named tokens.
 * A named token equal to the rc token is the same subscription and is folded in.
 * @param {Object} [options] - Environment, registry and rc seams
 * @returns {Array<{ name: string, token: string, added_at: string|null, expires_at: string|null }>}
 */
export const list_claude_accounts = ( {
    env = process.env,
    path = ACCOUNTS_PATH,
    rc_path = join( homedir(), `.babysitrc` ),
} = {} ) => {

    const named = Object.entries( read_account_registry( { path } ).accounts )
        .filter( ( [ name, entry ] ) => ACCOUNT_NAME.test( name ) && typeof entry?.token === `string` )
        .map( ( [ name, entry ] ) => ( { name, token: entry.token, added_at: entry.added_at || null, expires_at: entry.expires_at || null } ) )

    const default_token = env[ CLAUDE_TOKEN_ENV ]
    if( !default_token ) return named

    // The managed rc block carries its own mint and expiry dates
    const [ , added, expires ] = existsSync( rc_path ) ? readFileSync( rc_path, `utf8` ).match( RC_STAMP ) || [] : []
    const fallback = { name: DEFAULT_ACCOUNT, token: default_token, added_at: added || null, expires_at: expires || null }
    return [ fallback, ...named.filter( account => account.token !== default_token ) ]

}

/**
 * Remaining share of the tightest rate window: min over windows of 100 − used.
 * @param {Array<Object>} limits - Normalised limits with used_percent
 * @returns {number|null} 0–100, or null when no window reported a share
 */
export const account_headroom = ( limits = [] ) => {
    const used = limits.map( limit => limit.used_percent ).filter( value => typeof value === `number` && Number.isFinite( value ) )
    return used.length ? Math.max( 0, 100 - Math.max( ...used ) ) : null
}

/**
 * Read each account's quota headers, reusing cached readings younger than max_age_ms.
 * Fresh readings are written back so the next launch or dashboard frame is free.
 * @param {Array<Object>} accounts - From list_claude_accounts
 * @param {Object} [options]
 * @param {number} [options.max_age_ms] - Cache tolerance; 0 always probes
 * @param {Function} [options.request] - Header probe seam (claude_header_request)
 * @param {string} [options.cache_path] - Usage cache path
 * @param {Function} [options.now] - Clock seam
 * @returns {Promise<Array<{ name, status, limits, message, fetched_at, headroom }>>}
 */
export const probe_accounts = async ( accounts, {
    max_age_ms = ACCOUNT_USAGE_TTL_MS,
    request = token => claude_header_request( token, { timeout_ms: 10_000 } ),
    cache_path = ACCOUNT_USAGE_PATH,
    now = () => Date.now(),
} = {} ) => {

    const cache = read_json( cache_path ) || {}
    let changed = false

    const readings = await Promise.all( accounts.map( async ( { name, token } ) => {

        const hash = token_hash( token )
        const cached = cache[ name ]
        const fresh = cached?.token_hash === hash && now() - Date.parse( cached.fetched_at ) < max_age_ms
        if( fresh ) return { name, ...cached }

        const fetched_at = new Date( now() ).toISOString()
        const reading = await request( token )
            .then( limits => ( { status: `ok`, limits, message: null } ) )
            .catch( error => ( { status: `error`, limits: [], message: error.message } ) )

        // Errors are not cached: the next launch retries instead of trusting a blip
        if( reading.status === `ok` ) {
            cache[ name ] = { token_hash: hash, fetched_at, ...reading }
            changed = true
        }
        return { name, token_hash: hash, fetched_at, ...reading }

    } ) )

    if( changed ) write_private_json( cache_path, cache )
    return readings.map( ( { token_hash: _hash, ...reading } ) => ( { ...reading, headroom: account_headroom( reading.limits ) } ) )

}

/**
 * Last cached reading per account, whatever its age. Spends nothing.
 * @param {Object} [options] - Cache path seam
 * @returns {Object} name → { fetched_at, limits, headroom }
 */
export const cached_account_usage = ( { cache_path = ACCOUNT_USAGE_PATH } = {} ) => Object.fromEntries(
    Object.entries( read_json( cache_path ) || {} ).map( ( [ name, { fetched_at, limits = [] } ] ) => [ name, { fetched_at, limits, headroom: account_headroom( limits ) } ] )
)

/**
 * The reading with the most headroom; ties keep list order (default first).
 * Accounts that could not be read never win over one that could.
 * @param {Array<Object>} readings - From probe_accounts
 * @returns {Object|null} Winning reading
 */
export const pick_account = ( readings = [] ) => readings
    .filter( reading => reading.status === `ok` && reading.headroom !== null )
    .reduce( ( best, reading ) => !best || reading.headroom > best.headroom ? reading : best, null )

/**
 * Name of the account with most headroom, for a restart that moves a session
 * to the freshest subscription. False with fewer than two accounts or no
 * readable quota, so the session keeps the one it has.
 * @param {Object} [seams] - list/probe seams
 * @returns {Promise<string|false>}
 */
export const most_headroom_account = async ( { list = list_claude_accounts, probe = probe_accounts } = {} ) => {

    const accounts = list()
    if( accounts.length < 2 ) return false
    return pick_account( await probe( accounts ) )?.name || false

}

/**
 * Account for a Claude launch: an explicit choice, else the resumed session's,
 * else the only one, else (with two or more accounts) the one with most headroom.
 * @param {Object} options
 * @param {string|false} [options.requested] - `--account` value
 * @param {string|null} [options.stored] - Resumed session's claude_account
 * @param {Object} [options.seams] - list/probe seams
 * @returns {Promise<{ account: Object|null, reason: string }>} account null (no accounts) means "leave the default route alone"
 */
export const resolve_launch_account = async ( { requested = false, stored = null } = {}, {
    list = list_claude_accounts,
    probe = probe_accounts,
} = {} ) => {

    const accounts = list()
    const find = name => accounts.find( account => account.name === name ) || null

    if( requested ) {
        const account = find( requested )
        if( !account ) throw new Error( `Unknown Claude account "${ requested }". Known: ${ accounts.map( ( { name } ) => name ).join( `, ` ) || `none` } (babysit auth accounts)` )
        return { account, reason: `requested` }
    }

    if( stored && find( stored ) ) return { account: find( stored ), reason: `resumed` }

    // One account is used as is; the default one mounts nothing, a lone named one must
    if( accounts.length < 2 ) return { account: accounts[ 0 ] || null, reason: `single account` }

    const best = pick_account( await probe( accounts ) )
    return best
        ? { account: find( best.name ), reason: `most headroom (${ best.headroom }% left)` }
        : { account: accounts[ 0 ], reason: `no readable quota; using the first account` }

}

/**
 * Credential mount for a named account: a private env file the launcher copies
 * in with `docker cp`, sourced after ~/.babysitrc so it wins. `default` needs none.
 * @param {Object|null} account - Chosen account
 * @returns {Object[]} Zero or one `account_env` mount
 */
export const account_credential_mounts = account => account && account.name !== DEFAULT_ACCOUNT
    ? [ { type: `account_env`, key: CLAUDE_TOKEN_ENV, value: account.token, account: account.name } ]
    : []

/**
 * Per-account Claude usage in collect_usage's shape, so `babysit usage`,
 * `babysit watch`, and a per-session USAGE column (keyed on
 * session.claude_account) share one source. Cached for ACCOUNT_USAGE_TTL_MS.
 * @param {Object} [options] - max_age_ms plus list/probe seams
 * @returns {Promise<{ fetched_at: string, agents: Object[] }>} One `claude` entry per account, each with `account`
 */
export const account_usage_report = async ( { max_age_ms = ACCOUNT_USAGE_TTL_MS, list = list_claude_accounts, probe = probe_accounts } = {} ) => {

    const readings = await probe( list(), { max_age_ms } )

    // A dead named token is re-minted under its own name
    const remint_hint = ( name, message ) => name === DEFAULT_ACCOUNT ? message : message.replace( `--claude-token`, `--claude-token --name ${ name }` )

    return {
        fetched_at: new Date().toISOString(),
        agents: readings.map( ( { name, status, limits, message, fetched_at } ) => ( {
            agent: `claude`,
            provider: `anthropic`,
            account: name,
            fetched_at,
            status,
            limits,
            ...message ? { message: remint_hint( name, message ) } : {},
            ...status === `ok` ? { source: `Claude rate-limit headers (1-token request)` } : {},
        } ) ),
    }

}

/**
 * collect_usage's `claude_accounts` hook: per-account entries with two or
 * more accounts, null (the single unchanged entry) otherwise.
 * @param {Object} [options] - max_age_ms plus list/probe seams
 * @returns {Function} Async hook
 */
export const claude_account_entries = ( { max_age_ms = ACCOUNT_USAGE_TTL_MS, list = list_claude_accounts, probe = probe_accounts } = {} ) => async () => {

    if( list().length < 2 ) return null

    const { agents } = await account_usage_report( { max_age_ms, list, probe } )
    return agents

}

/**
 * collect_usage, with Claude split per account when two or more exist.
 * @param {Object} [options] - collect_usage options plus max_age_ms
 * @returns {Promise<Object>} Usage report
 */
export const collect_account_usage = ( { max_age_ms = ACCOUNT_USAGE_TTL_MS, ...options } = {} ) => collect_usage( {
    ...options,
    claude_accounts: claude_account_entries( { max_age_ms } ),
} )

const day = value => value ? String( value ).slice( 0, 10 ) : `-`

/**
 * One row per account for `babysit auth accounts`. Never includes tokens.
 * @param {Array<Object>} accounts - From list_claude_accounts
 * @param {Object} usage - From cached_account_usage
 * @param {number} [now] - Epoch ms for the reading's age
 * @returns {string} Aligned table ending in a newline
 */
export const format_accounts_table = ( accounts, usage, now = Date.now() ) => {

    // Minutes under an hour, hours under two days, then days
    const age = fetched_at => {
        const minutes = Math.max( 0, Math.round( ( now - Date.parse( fetched_at ) ) / 60_000 ) )
        if( minutes < 60 ) return `${ minutes }m`
        if( minutes < 2_880 ) return `${ Math.round( minutes / 60 ) }h`
        return `${ Math.round( minutes / 1_440 ) }d`
    }
    const headroom = name => {
        const reading = usage[ name ]
        if( reading?.headroom === null || reading?.headroom === undefined ) return `unknown`
        return `${ reading.headroom }% left (${ age( reading.fetched_at ) } ago)`
    }

    const rows = [
        [ `NAME`, `ADDED`, `EXPIRES`, `HEADROOM` ],
        ...accounts.map( ( { name, added_at, expires_at } ) => [ name, day( added_at ), day( expires_at ), headroom( name ) ] ),
    ]
    const widths = rows[ 0 ].map( ( _, column ) => Math.max( ...rows.map( row => row[ column ].length ) ) )
    return rows.map( row => row.map( ( cell, column ) => cell.padEnd( widths[ column ] ) ).join( `  ` ).trimEnd() ).join( `\n` ) + `\n`

}

/**
 * `babysit auth accounts [remove <name>]`.
 * @param {Object} cmd - Parsed command with account_verb and account_name
 * @param {Object} [options] - Output and registry seams
 * @returns {Promise<number>} Exit code
 */
export const cmd_auth_accounts = async ( cmd, {
    output = process.stdout,
    list = list_claude_accounts,
    usage = cached_account_usage,
    remove = remove_account,
} = {} ) => {

    if( cmd.account_verb === `remove` ) {
        if( cmd.account_name === DEFAULT_ACCOUNT ) {
            output.write( `"${ DEFAULT_ACCOUNT }" is the ${ CLAUDE_TOKEN_ENV } export in ~/.babysitrc; delete that block to drop it.\n` )
            return 1
        }
        const removed = remove( cmd.account_name )
        output.write( removed ? `Removed Claude account "${ cmd.account_name }".\n` : `No Claude account named "${ cmd.account_name }".\n` )
        return removed ? 0 : 1
    }

    const accounts = list()
    if( !accounts.length ) {
        output.write( `No Claude accounts. Add one: babysit auth init --claude-token [--name <account>]\n` )
        return 0
    }

    output.write( format_accounts_table( accounts, usage() ) )
    if( accounts.length < 2 ) output.write( `One account: launches use it as before. Add another with babysit auth init --claude-token --name <account>.\n` )
    return 0

}
