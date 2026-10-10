// Normalize provider-native units. Percentages are not token allowances, and
// credits are not dollars unless the provider explicitly identifies a currency.
const numeric = value => typeof value === `number` && Number.isFinite( value ) ? value : null
const require_number = ( value, field ) => {
    if( numeric( value ) === null ) throw new Error( `Usage endpoint returned invalid ${ field }` )
    return value
}
const epoch = value => {
    if( value === undefined || value === null ) return null
    const date = new Date( require_number( value, `reset timestamp` ) * 1000 )
    if( !Number.isFinite( date.getTime() ) ) throw new Error( `Usage endpoint returned invalid reset timestamp` )
    return date.toISOString()
}
const money = value => {
    if( value?.amount_minor === null || value?.amount_minor === undefined ) return null
    const amount = require_number( value.amount_minor, `money amount` )
    const exponent = require_number( value.exponent, `money exponent` )
    if( !Number.isInteger( exponent ) || exponent < 0 || !Number.isFinite( 10 ** exponent ) ) throw new Error( `Usage endpoint returned invalid money exponent` )
    return amount / 10 ** exponent
}
const duration_minutes = value => {
    const seconds = require_number( value, `quota window duration` )
    if( seconds <= 0 ) throw new Error( `Usage endpoint returned invalid quota window duration` )
    return seconds / 60
}

/** Normalize Claude's current scoped quotas, retaining legacy endpoint support. */
export const claude_usage = data => {

    const limits = Array.isArray( data.limits ) ? data.limits.map( limit => ( {
        name: [ limit.kind, limit.scope?.model?.display_name, limit.scope?.surface ].filter( value => typeof value === `string` ).join( ` / ` ),
        used_percent: numeric( limit.percent ),
        resets_at: limit.resets_at || null,
    } ) ) : Object.entries( data ).filter( ( [ key, value ] ) =>
        /^(five_hour|seven_day)/.test( key ) && numeric( value?.utilization ) !== null
    ).map( ( [ name, value ] ) => ( {
        name, used_percent: value.utilization, resets_at: value.resets_at || null,
    } ) )
    if( data.spend?.enabled && data.spend.used ) {
        const { currency } = data.spend.used
        limits.push( {
            name: `extra usage`, unit: currency,
            used: money( data.spend.used ),
            limit: money( data.spend.limit ),
            used_percent: numeric( data.spend.percent ),
        } )
    } else if( data.extra_usage?.is_enabled ) {
        // Legacy responses expose credits; preserve them without assuming cents.
        limits.push( { name: `extra usage`, unit: `credits`, used: data.extra_usage.used_credits, limit: data.extra_usage.monthly_limit, used_percent: data.extra_usage.utilization } )
    }
    return limits

}

// Tokens from `claude setup-token` cannot read the usage endpoint, but every
// model response carries the same quotas as rate-limit headers
const CLAUDE_HEADER_LIMITS = { '5h': `session`, '7d': `weekly_all` }
const CLAUDE_HEADER_PATTERN = /^anthropic-ratelimit-unified-(.+)-utilization$/

/** Normalize Claude's `anthropic-ratelimit-unified-<claim>-*` response headers. */
export const claude_header_usage = headers => [ ...headers.keys() ]
    .map( key => key.match( CLAUDE_HEADER_PATTERN )?.[ 1 ] )
    .filter( Boolean )
    .map( claim => {
        const utilization = Number( headers.get( `anthropic-ratelimit-unified-${ claim }-utilization` ) )
        const reset = headers.get( `anthropic-ratelimit-unified-${ claim }-reset` )
        return {
            name: CLAUDE_HEADER_LIMITS[ claim ] || claim,
            used_percent: Number.isFinite( utilization ) ? Math.round( utilization * 100 ) : null,
            resets_at: reset ? epoch( Number( reset ) ) : null,
        }
    } )
    .filter( limit => limit.used_percent !== null )

/** Normalize native app-server snapshots and the underlying account endpoint. */
export const codex_usage = data => {

    if( data.rate_limit ) {
        const window = value => value ? {
            usedPercent: value.used_percent,
            windowDurationMins: duration_minutes( value.limit_window_seconds ),
            resetsAt: value.reset_at,
        } : null
        const bucket = value => ( {
            primary: window( value?.primary_window ),
            secondary: window( value?.secondary_window ),
        } )
        const primary = {
            ...bucket( data.rate_limit ),
            credits: data.credits && { hasCredits: data.credits.has_credits, unlimited: data.credits.unlimited, balance: data.credits.balance },
            individualLimit: data.spend_control?.individual_limit && {
                ...data.spend_control.individual_limit,
                remainingPercent: data.spend_control.individual_limit.remaining_percent,
                resetsAt: data.spend_control.individual_limit.reset_at,
            },
        }
        const by_id = { codex: primary }
        if( data.code_review_rate_limit ) by_id.code_review = bucket( data.code_review_rate_limit )
        if( Array.isArray( data.additional_rate_limits ) ) data.additional_rate_limits.forEach( limit => {
            if( limit.rate_limit && ( limit.limit_name || limit.metered_feature ) ) {
                by_id[ limit.limit_name || limit.metered_feature ] = bucket( limit.rate_limit )
            }
        } )
        return codex_usage( { rateLimits: primary, rateLimitsByLimitId: by_id } )
    }
    const buckets = data.rateLimitsByLimitId && Object.keys( data.rateLimitsByLimitId ).length
        ? Object.entries( data.rateLimitsByLimitId )
        : [ [ `codex`, data.rateLimits ] ]
    const limits = buckets.flatMap( ( [ id, bucket ] ) => {
        if( !bucket ) return []
        const windows = [ bucket.primary, bucket.secondary ].filter( Boolean ).map( window => ( {
            name: `${ bucket.limitName || id } / ${ window.windowDurationMins ? `${ window.windowDurationMins } min` : `window` }`,
            used_percent: numeric( window.usedPercent ),
            resets_at: epoch( window.resetsAt ),
        } ) )
        if( bucket.individualLimit ) windows.push( {
            name: `${ id } / individual limit`, unit: `credits`,
            used: bucket.individualLimit.used, limit: bucket.individualLimit.limit,
            remaining_percent: bucket.individualLimit.remainingPercent,
            resets_at: epoch( bucket.individualLimit.resetsAt ),
        } )
        return windows
    } )
    const credits = data.rateLimits?.credits || buckets.find( ( [ , bucket ] ) => bucket?.credits )?.[1].credits
    if( credits ) limits.push( { name: `credit balance`, unit: `credits`, remaining: credits.balance, unlimited: credits.unlimited } )
    return limits

}

/** OpenRouter's budget follows its reset interval; lifetime spend is separate. */
export const openrouter_usage = ( { data } ) => {

    if( !data || typeof data !== `object` ) return []
    const period_usage = { daily: data.usage_daily, weekly: data.usage_weekly, monthly: data.usage_monthly }
    const byok_usage = { daily: data.byok_usage_daily, weekly: data.byok_usage_weekly, monthly: data.byok_usage_monthly }
    const period = data.limit_reset || `lifetime`
    const spent = period === `lifetime` ? data.usage : period_usage[ period ]
    const byok = period === `lifetime` ? data.byok_usage : byok_usage[ period ]
    const used = numeric( spent ) === null ? null : spent + ( data.include_byok_in_limit ? numeric( byok ) || 0 : 0 )
    const limits = [ {
        name: `API key / ${ period }`, unit: `USD`, used,
        limit: numeric( data.limit ), remaining: numeric( data.limit_remaining ),
        unlimited: data.limit === null,
    } ]
    if( period !== `lifetime` ) limits.push( { name: `API key / lifetime spend`, unit: `USD`, used: numeric( data.usage ) } )
    if( data.free_model_daily_requests ) limits.push( { name: `free models / daily`, unit: `requests`, ...data.free_model_daily_requests } )
    return limits

}

/** Fetch only fixed provider endpoints. Never surface response bodies or bearer values. */
export const provider_request = async ( url, token, { headers = {}, fetch_fn = fetch, timeout_ms = 15000 } = {} ) => {

    let response
    try {
        response = await fetch_fn( url, {
            headers: { Authorization: `Bearer ${ token }`, ...headers },
            signal: AbortSignal.timeout( timeout_ms ),
            redirect: `error`,
        } )
    } catch {
        throw new Error( `Usage endpoint unreachable or timed out` )
    }
    if( !response.ok ) {
        const reason = [ 401, 403 ].includes( response.status ) ? `; sign in again with the provider CLI` : response.status === 429 ? `; retry later` : ``
        throw Object.assign( new Error( `Usage endpoint returned HTTP ${ response.status }${ reason }` ), { http_status: response.status } )
    }
    try {
        return await response.json()
    } catch {
        throw new Error( `Usage endpoint returned invalid JSON` )
    }

}

// The cheapest model; OAuth subscription tokens only answer requests that
// identify as Claude Code (anything else is refused as a bare 429)
const CLAUDE_HEADER_MODEL = `claude-haiku-5-5`
const CLAUDE_CODE_IDENTITY = `You are Claude Code, Anthropic's official CLI for Claude.`

/**
 * Spend one output token to read Claude's quota headers. A limit that is
 * already exhausted still answers with headers, so any status carrying them
 * counts. Never surfaces response bodies or bearer values.
 */
export const claude_header_request = async ( token, { fetch_fn = fetch, timeout_ms = 15000 } = {} ) => {

    let response
    try {
        response = await fetch_fn( `https://api.anthropic.com/v1/messages`, {
            method: `POST`,
            headers: {
                Authorization: `Bearer ${ token }`,
                'anthropic-version': `2023-06-01`,
                'anthropic-beta': `oauth-2025-04-20`,
                'content-type': `application/json`,
            },
            body: JSON.stringify( {
                model: CLAUDE_HEADER_MODEL,
                max_tokens: 1,
                system: CLAUDE_CODE_IDENTITY,
                messages: [ { role: `user`, content: `hi` } ],
            } ),
            signal: AbortSignal.timeout( timeout_ms ),
            redirect: `error`,
        } )
    } catch {
        throw new Error( `Usage endpoint unreachable or timed out` )
    }

    // Free the connection; the body is never read
    response.body?.cancel().catch( () => {} )

    const limits = claude_header_usage( response.headers )
    if( limits.length ) return limits

    const reason = [ 401, 403 ].includes( response.status ) ? `; run babysit auth init --claude-token on the host` : ``
    throw Object.assign( new Error( `Claude returned HTTP ${ response.status } without usage headers${ reason }` ), { http_status: response.status } )

}
