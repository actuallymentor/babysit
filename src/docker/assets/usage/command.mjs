import { discover_credentials } from './credentials.mjs'
import { read_codex_limits } from './codex.mjs'
import { claude_usage, codex_usage, openrouter_usage, provider_request } from './providers.mjs'

const unavailable = message => ( { status: `unavailable`, message, limits: [] } )
const unauthenticated = () => ( { status: `unauthenticated`, message: `No credentials found`, limits: [] } )
const unsupported = () => unavailable( `This provider does not expose account limits through this credential; local token/cost history is not an account quota` )

/** Collect all locally authenticated providers independently; one failure cannot hide others. */
export const collect_usage = async ( {
    credentials,
    discover = discover_credentials,
    fetch_fn = fetch,
    codex_read = read_codex_limits,
    allow_native_refresh = false,
    now = () => new Date().toISOString(),
} = {} ) => {

    const auth = credentials || await discover()
    const env = auth.env || {}
    const tasks = []
    const query = ( agent, provider, task ) => tasks.push( ( async () => {
        try {
            const result = await task()
            return { agent, provider, fetched_at: now(), ...result }
        } catch ( error ) {
            // OpenCode owns its OAuth refresh tokens. Never refresh those through
            // another agent's CLI, which may represent a different account.
            const message = agent === `opencode` && [ 401, 403 ].includes( error.http_status )
                ? `Usage endpoint returned HTTP ${ error.http_status }; run opencode auth login for this provider, then retry`
                : error.message
            return { agent, provider, fetched_at: now(), status: `error`, message, limits: [] }
        }
    } )() )
    const request = ( url, token, headers ) => provider_request( url, token, { headers, fetch_fn } )
    const successful = ( limits, source ) => limits.length
        ? { status: `ok`, source, limits }
        : { ...unavailable( `Provider returned no account limits` ), source }
    const claude = async token => successful( claude_usage( await request(
        `https://api.anthropic.com/api/oauth/usage`, token, { 'anthropic-beta': `oauth-2025-04-20` }
    ) ), `Claude OAuth usage` )
    const codex_oauth = async ( token, account ) => successful( codex_usage( await request(
        `https://chatgpt.com/backend-api/wham/usage`, token, account ? { 'ChatGPT-Account-Id': account } : {}
    ) ), `Codex account usage` )
    const openrouter = async token => successful( openrouter_usage( await request(
        `https://openrouter.ai/api/v1/key`, token
    ) ), `OpenRouter API key` )

    query( `claude`, `anthropic`, () => {
        if( env.ANTHROPIC_API_KEY ) return unsupported()
        const token = env.CLAUDE_CODE_OAUTH_TOKEN || auth.claude?.claudeAiOauth?.accessToken
        return token ? claude( token ) : unauthenticated()
    } )
    query( `codex`, `openai`, async () => {
        const managed = env.BABYSIT_EFFORT_AGENT === `codex` && env.BABYSIT_EFFORT_ENDPOINT
        const token = auth.codex?.tokens?.access_token
        // Access-token reads never rotate credentials. Only the host wrapper,
        // holding its authentication lease, permits a native refresh fallback.
        if( token && !managed ) {
            try {
                return await codex_oauth( token, auth.codex.tokens.account_id )
            } catch ( error ) {
                if( !allow_native_refresh || ![ 401, 403 ].includes( error.http_status ) ) throw error
            }
        }
        if( !token && ( env.CODEX_API_KEY || env.OPENAI_API_KEY || auth.codex?.OPENAI_API_KEY ) ) return unsupported()
        try {
            const snapshot = await codex_read( { env } )
            if( !snapshot ) return unauthenticated()
            if( snapshot.unsupported ) return unsupported()
            return successful( codex_usage( snapshot ), `Codex app-server` )
        } catch ( error ) {
            if( !token && error.message === `Codex CLI unavailable` ) return unauthenticated()
            throw error
        }
    } )
    query( `antigravity`, `google`, () => auth.antigravity || env.GEMINI_API_KEY
        ? unavailable( `Account quota integration unavailable for this Antigravity credential; run /usage in agy` )
        : unauthenticated()
    )

    const provider_auth = { ...auth.opencode }
    // OpenCode also resolves standard provider environment keys. Their budgets
    // remain separate from subscription OAuth even on the same provider.
    const environment_providers = {
        openrouter: env.OPENROUTER_API_KEY,
        anthropic: env.ANTHROPIC_API_KEY,
        openai: env.OPENAI_API_KEY,
        google: env.GOOGLE_GENERATIVE_AI_API_KEY,
    }
    Object.entries( environment_providers ).forEach( ( [ provider, key ] ) => {
        if( key && !provider_auth[ provider ] ) provider_auth[ provider ] = { type: `api`, key }
    } )
    const providers = Object.entries( provider_auth ).filter( ( [ , credential ] ) => credential && typeof credential === `object` )
    if( !providers.length ) query( `opencode`, null, unauthenticated )
    providers.forEach( ( [ provider, credential ] ) => query( `opencode`, provider, () => {
        if( provider === `openrouter` && credential.type === `api` && credential.key ) return openrouter( credential.key )
        if( provider === `anthropic` && credential.type === `oauth` && credential.access ) return claude( credential.access )
        if( provider === `openai` && credential.type === `oauth` && credential.access ) return codex_oauth( credential.access, credential.accountId )
        return unsupported()
    } ) )
    return { fetched_at: now(), agents: await Promise.all( tasks ) }

}

const safe_text = value => String( value ).replace( /[\x00-\x1f\x7f-\x9f]/g, `` )
const amount = value => value === null || value === undefined ? null : safe_text( value )

/** Render native windows/units without presenting missing information as zero. */
export const format_usage = report => report.agents.map( result => {
    const title = `${ result.agent }${ result.provider ? ` / ${ safe_text( result.provider ) }` : `` }`
    if( result.status !== `ok` ) return `${ title }: ${ result.status } — ${ safe_text( result.message ) }`
    return [ title, ...result.limits.map( limit => {
        const values = []
        if( typeof limit.used_percent === `number` ) values.push( `${ limit.used_percent }% used` )
        if( typeof limit.remaining_percent === `number` ) values.push( `${ limit.remaining_percent }% remaining` )
        if( amount( limit.used ) !== null ) values.push( `${ amount( limit.used ) }${ amount( limit.limit ) !== null ? ` / ${ amount( limit.limit ) }` : `` } ${ limit.unit || `` } used`.trim() )
        else if( amount( limit.limit ) !== null ) values.push( `limit ${ amount( limit.limit ) } ${ limit.unit || `` }`.trim() )
        if( amount( limit.remaining ) !== null ) values.push( `${ amount( limit.remaining ) } ${ limit.unit || `` } remaining`.trim() )
        if( limit.unlimited ) values.push( `no ${ limit.unit === `USD` ? `key spending cap` : `limit` }` )
        if( limit.resets_at ) values.push( `resets ${ safe_text( limit.resets_at ) }` )
        return `  ${ safe_text( limit.name ) }: ${ values.join( ` · ` ) || `not reported` }`
    } ) ].join( `\n` )
} ).join( `\n\n` )

/** Run the same command on host and in the image; return a partial-failure exit code. */
export const run_usage = async ( args = [], { output = process.stdout, ...options } = {} ) => {

    if( args.includes( `--help` ) || args.includes( `-h` ) ) {
        output.write( `Usage: babysit usage [--json]\nShow account limits for authenticated agents. Exit 1 means some usage is unavailable.\n` )
        return 0
    }
    if( args.some( argument => argument !== `--json` ) ) throw new Error( `Usage: babysit usage [--json]` )
    const report = await collect_usage( options )
    output.write( `${ args.includes( `--json` ) ? JSON.stringify( report, null, 2 ) : format_usage( report ) }\n` )
    return report.agents.some( result => result.status === `error` || result.status === `unavailable` ) ? 1 : 0

}
