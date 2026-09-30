import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const endpoint = `https://artificialanalysis.ai/api/v2/language/models/free`
const safe_text = value => String( value ?? `` ).replace( /[\x00-\x1f\x7f-\x9f]/g, `` )
const metric = value => Number.isFinite( value ) && value >= 0 ? value : null

/** Keep only benchmark fields; never persist token pricing or credentials. */
export const normalise_benchmark = model => {
    const intelligence = metric( model.evaluations?.artificial_analysis_intelligence_index )
    const cost = metric( model.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost )
    return {
        id: safe_text( model.id ),
        name: safe_text( model.name ),
        provider: safe_text( model.model_creator?.name ),
        intelligence,
        coding: metric( model.evaluations?.artificial_analysis_coding_index ),
        agentic: metric( model.evaluations?.artificial_analysis_agentic_index ),
        cost,
        cost_per_point: intelligence > 0 && cost !== null ? metric( cost / intelligence ) : null,
    }
}

/** Fetch a complete snapshot; one deadline covers every page and body. */
export const fetch_benchmarks = async ( api_key, { fetch_fn = fetch } = {} ) => {
    const signal = AbortSignal.timeout( 30_000 )
    const models = new Map()
    let index_version
    for( let page = 1; page <= 100; page++ ) {
        const response = await fetch_fn( `${ endpoint }?page=${ page }`, {
            headers: { 'x-api-key': api_key }, signal, redirect: `error`,
        } )
        if( !response.ok ) throw new Error( `Artificial Analysis returned HTTP ${ response.status }` )
        const body = await response.json()
        if( !Array.isArray( body.data ) || body.pagination?.page !== page || typeof body.pagination.has_more !== `boolean` ) {
            throw new Error( `Invalid Artificial Analysis response` )
        }
        if( page === 1 ) index_version = body.intelligence_index_version
        else if( body.intelligence_index_version !== index_version ) throw new Error( `Artificial Analysis index changed during refresh` )
        for( const model of body.data ) {
            if( !model?.id || !model.name || !model.model_creator?.name ) throw new Error( `Invalid Artificial Analysis model` )
            models.set( model.id, normalise_benchmark( model ) )
        }
        if( !body.pagination.has_more ) return { schema: 1, fetched_at: Date.now(), index_version: metric( index_version ), models: [ ...models.values() ] }
    }
    throw new Error( `Artificial Analysis pagination exceeded 100 pages` )
}

const read_cache = async path => {
    try {
        const data = JSON.parse( await readFile( path, `utf8` ) )
        if( data.schema !== 1 || !Number.isFinite( data.fetched_at ) || !Number.isFinite( new Date( data.fetched_at ).getTime() ) || !Array.isArray( data.models ) ) return null
        if( !data.models.every( model => model && typeof model.name === `string` && typeof model.provider === `string`
            && [ `intelligence`, `coding`, `agentic`, `cost`, `cost_per_point` ].every( key => model[key] === null || metric( model[key] ) !== null ) ) ) return null
        // Rebuild the allowlist even on disk reads: shared cache input is untrusted.
        return { schema: 1, fetched_at: data.fetched_at, index_version: metric( data.index_version ), models: data.models.map( model => ( {
            id: safe_text( model.id ), name: safe_text( model.name ), provider: safe_text( model.provider ),
            intelligence: model.intelligence, coding: model.coding, agentic: model.agentic, cost: model.cost,
            cost_per_point: model.intelligence > 0 && model.cost !== null ? metric( model.cost / model.intelligence ) : null,
        } ) ) }
    } catch {
        return null
    }
}

// Kernel locks work across container PID namespaces and release on crashes.
// Keep the lock file: unlinking it would let waiters lock different inodes.
const acquire_lock = path => new Promise( ( resolve, reject ) => {
    const child = spawn( `flock`, [ `-w`, `35`, path, `sh`, `-c`, `printf ready; cat >/dev/null` ], { stdio: [ `pipe`, `pipe`, `ignore` ] } )
    let acquired = false
    child.stdin.on( `error`, () => {} )
    child.once( `error`, () => reject( new Error( `Benchmark cache requires flock; run inside a Babysit container` ) ) )
    const closed = new Promise( done => child.once( `close`, done ) )
    child.once( `close`, () => {
        if( !acquired ) reject( new Error( `Timed out waiting for benchmark cache refresh` ) )
    } )
    child.stdout.once( `data`, () => {
        acquired = true
        resolve( async () => {
            child.stdin.end()
            await closed
        } )
    } )
} )

/** Shared snapshot, with per-caller TTL and stale fallback on refresh failure. */
export const load_benchmarks = async ( {
    env = process.env,
    cache_path = join( homedir(), `.cache`, `babysit`, `benchmarks.json` ),
    fetch_fn = fetch,
    warn = message => process.stderr.write( `${ message }\n` ),
} = {} ) => {
    const api_key = env.ARTIFICIAL_ANALYSIS_API_KEY?.trim()
    if( !api_key ) throw new Error( `Artificial analysis API key not set, could not get latest benchmarks` )
    const setting = env.ARTIFICIAL_ANALYSIS_TTL_MINUTES
    const ttl = setting === undefined ? 15 : Number( setting )
    if( setting?.trim() === `` || !Number.isFinite( ttl ) || ttl < 0 ) throw new Error( `ARTIFICIAL_ANALYSIS_TTL_MINUTES must be a nonnegative number` )
    const refresh = async () => {
        try {
            return await fetch_benchmarks( api_key, { fetch_fn } )
        } catch {
            throw new Error( `Could not get latest benchmarks; check Artificial Analysis API key and connection` )
        }
    }
    if( ttl === 0 ) return refresh()

    let cached = await read_cache( cache_path )
    const fresh = data => data && Date.now() >= data.fetched_at && Date.now() - data.fetched_at < ttl * 60_000
    if( fresh( cached ) ) return cached
    let release
    try {
        try {
            await mkdir( dirname( cache_path ), { recursive: true } )
            release = await acquire_lock( `${ cache_path }.lock` )
        } catch {
            // Hosts without flock still cache atomically. Concurrent refreshes
            // may overlap; a missing lock must not disable the caller's TTL.
        }
        cached = await read_cache( cache_path ) || cached
        if( fresh( cached ) ) return cached
        const data = await refresh()
        const temporary = `${ cache_path }.${ randomUUID() }.tmp`
        try {
            await writeFile( temporary, JSON.stringify( data ), { mode: 0o600 } )
            await rename( temporary, cache_path )
        } catch {
            warn( `Warning: could not save benchmark cache; showing live data` )
        } finally {
            await rm( temporary, { force: true } ).catch( () => {} )
        }
        return data
    } catch {
        // Fetch errors can contain URLs or headers. Never echo their raw text.
        if( !cached ) throw new Error( `Could not get latest benchmarks; check Artificial Analysis API key and connection` )
        warn( `Warning: could not refresh benchmarks; using stale data from ${ new Date( cached.fetched_at ).toISOString() }` )
        return { ...cached, stale: true }
    } finally {
        if( release ) await release()
    }
}
