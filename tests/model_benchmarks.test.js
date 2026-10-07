import { afterEach, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { load_benchmarks, normalise_benchmark } from '../src/docker/assets/effort/benchmark-cache.mjs'
import { benchmark_providers } from '../src/docker/assets/effort/benchmark-providers.mjs'
import { parse_benchmarks, select_benchmarks, run_benchmarks } from '../src/docker/assets/effort/benchmarks.mjs'

const directories = []
afterEach( async () => {
    await Promise.all( directories.splice( 0 ).map( path => rm( path, { recursive: true, force: true } ) ) )
} )
const fixture = async () => {
    const directory = await mkdtemp( join( tmpdir(), `babysit-benchmarks-` ) )
    directories.push( directory )
    return { cache_path: join( directory, `benchmarks.json` ), env: { ARTIFICIAL_ANALYSIS_API_KEY: `fixture-secret` } }
}
const model = ( id, intelligence = 20, coding = 30, cost = 2, provider = `OpenAI` ) => ( {
    id, name: id, model_creator: { name: provider },
    evaluations: { artificial_analysis_intelligence_index: intelligence, artificial_analysis_coding_index: coding, artificial_analysis_agentic_index: 10 },
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: cost } },
    pricing: { price_1m_input_tokens: 99 },
} )
const page = ( data, current = 1, has_more = false ) => ( {
    data, intelligence_index_version: 4.3, pagination: { page: current, has_more },
} )

it( `defaults to coding; provider filter, sort, then limit; missing metrics stay`, async () => {
    const models = [ model( `cheap`, 40, 40, 1 ), model( `coder`, 20, 80, 4 ), model( `missing`, 90, null ), model( `foreign`, 99, 99, 1, `Google` ) ].map( normalise_benchmark )
    const providers = new Set( [ `OpenAI` ] )
    expect( parse_benchmarks( [ `--benchmarks` ] ).sort ).toBe( `coding` )
    expect( select_benchmarks( models, providers, { limit: 1 } ).map( row => row.name ) ).toEqual( [ `coder` ] )
    expect( select_benchmarks( models, providers, { sort: `cost-per-point` } ).map( row => row.name ) ).toEqual( [ `missing`, `cheap`, `coder` ] )
    expect( select_benchmarks( models, providers ).map( row => row.name ) ).toEqual( [ `coder`, `cheap`, `missing` ] )
    expect( parse_benchmarks( [ `--benchmarks`, `--all` ] ) ).toEqual( parse_benchmarks( [ `--benchmarks` ] ) )
    const text = await run_benchmarks( [ `--benchmarks`, `--limit`, `1` ], {
        load: async () => ( { fetched_at: Date.now(), models } ), providers: async () => providers,
    } )
    expect( text ).toContain( `sorted by coding` )
    expect( text ).toContain( `1/3 rows` )
    expect( text ).toContain( `$/point` )
    expect( text ).not.toContain( `price_1m` )
} )

it( `handles every sort, missing columns, zero cost and undefined ratios`, () => {
    const rows = [ model( `B`, 40, 20, 0 ), model( `A`, 20, 40, 2 ), model( `Zero`, 0, 90, 1 ), model( `No cost`, 30, 80, null ) ].map( normalise_benchmark )
    const providers = new Set( [ `OpenAI` ] )
    expect( select_benchmarks( rows, providers ).map( row => row.name ) ).toEqual( [ `Zero`, `No cost`, `A`, `B` ] )
    for( const sort of [ `intelligence`, `cost`, `cost-per-point` ] ) expect( select_benchmarks( rows, providers, { sort } )[0].name ).toBe( `B` )
    expect( select_benchmarks( rows, providers, { sort: `name` } )[0].name ).toBe( `A` )
    expect( select_benchmarks( rows, providers, { sort: `agentic` } )[0].name ).toBe( `A` )
    expect( select_benchmarks( rows, providers, { sort: `cost-per-point` } ).slice( -2 ).every( row => row.cost_per_point === null ) ).toBe( true )
    const incomplete = rows.map( row => ( { ...row, agentic: null } ) )
    expect( select_benchmarks( incomplete, providers ) ).toHaveLength( 4 )
} )

it( `rejects invalid flags and model-switch combinations`, () => {
    for( const value of [ `0`, `-1`, `1.5`, `NaN`, `99999999999999999`, undefined ] ) {
        expect( () => parse_benchmarks( [ `--benchmarks`, `--limit`, value ] ) ).toThrow( `positive integer` )
    }
    for( const args of [ [ `--sort`, `nope` ], [ `--status`, `id` ], [ `some-model` ], [ `--wat` ] ] ) {
        expect( () => parse_benchmarks( [ `--benchmarks`, ...args ] ) ).toThrow( `Usage` )
    }
} )

it( `requires installed CLIs plus credentials; routers never imply every creator`, async () => {
    const discover = async () => ( { env: {}, codex: { tokens: { access_token: `secret` } }, claude: {}, antigravity: {},
        opencode: { anthropic: { key: `secret` }, google: { access: `secret` }, openrouter: { key: `secret` }, deepseek: {} },
    } )
    expect( [ ...await benchmark_providers( { discover, has_cli: async () => false } ) ] ).toEqual( [] )
    expect( [ ...await benchmark_providers( { discover, has_cli: async () => true } ) ].sort() ).toEqual( [ `Anthropic`, `Google`, `OpenAI` ] )
} )

it( `fetches all pages once, sanitizes fields, and reuses the shared snapshot`, async () => {
    const options = await fixture()
    const calls = []
    const fetch_fn = async ( url, init ) => {
        calls.push( url )
        expect( init.headers[`x-api-key`] ).toBe( `fixture-secret` )
        const current = Number( new URL( url ).searchParams.get( `page` ) )
        return Response.json( page( [ model( `model-${ current }` ) ], current, current === 1 ) )
    }
    const first = await load_benchmarks( { ...options, fetch_fn } )
    expect( first.models ).toHaveLength( 2 )
    await load_benchmarks( { ...options, fetch_fn } )
    expect( calls ).toHaveLength( 2 )
    const cache = await readFile( options.cache_path, `utf8` )
    expect( cache ).not.toContain( `pricing` )
    expect( cache ).not.toContain( `fixture-secret` )
    expect( normalise_benchmark( model( `name\n\x1b` ) ).name ).toBe( `name` )
} )

it( `failed later pages preserve the last complete snapshot and warn on stderr`, async () => {
    const options = await fixture()
    await load_benchmarks( { ...options, fetch_fn: async () => Response.json( page( [ model( `old` ) ] ) ) } )
    const cache = JSON.parse( await readFile( options.cache_path, `utf8` ) )
    cache.fetched_at -= 16 * 60_000
    await writeFile( options.cache_path, JSON.stringify( cache ) )
    const warnings = []
    const result = await load_benchmarks( { ...options, warn: value => warnings.push( value ), fetch_fn: async url => {
        if( new URL( url ).searchParams.get( `page` ) === `1` ) return Response.json( page( [ model( `partial` ) ], 1, true ) )
        return new Response( `secret upstream body`, { status: 429 } )
    } } )
    expect( result.stale ).toBe( true )
    expect( result.models[0].name ).toBe( `old` )
    expect( warnings[0] ).toContain( `stale` )
    expect( await readFile( options.cache_path, `utf8` ) ).toBe( JSON.stringify( cache ) )
} )

it( `TTL zero bypasses disk; invalid TTL and missing key never fetch`, async () => {
    const options = await fixture()
    let calls = 0
    const fetch_fn = async () => {
        calls++; return Response.json( page( [] ) ) 
    }
    for( let index = 0; index < 2; index++ ) await load_benchmarks( { ...options, env: { ...options.env, ARTIFICIAL_ANALYSIS_TTL_MINUTES: `0` }, fetch_fn } )
    expect( calls ).toBe( 2 )
    await expect( readFile( options.cache_path ) ).rejects.toThrow()
    for( const setting of [ `-1`, `nonsense`, ``, `Infinity` ] ) await expect( load_benchmarks( { ...options, env: { ...options.env, ARTIFICIAL_ANALYSIS_TTL_MINUTES: setting }, fetch_fn } ) ).rejects.toThrow( `nonnegative` )
    await expect( load_benchmarks( { ...options, env: {}, fetch_fn } ) ).rejects.toThrow( `Artificial analysis API key not set, could not get latest benchmarks` )
    expect( calls ).toBe( 2 )
} )

it( `invalid caches refetch; cached extra fields never enter JSON output`, async () => {
    const options = await fixture()
    await writeFile( options.cache_path, `{broken` )
    await load_benchmarks( { ...options, fetch_fn: async () => Response.json( page( [ model( `safe` ) ] ) ) } )
    const cache = JSON.parse( await readFile( options.cache_path, `utf8` ) )
    cache.models[0].pricing = { secret: `must-not-appear` }
    await writeFile( options.cache_path, JSON.stringify( cache ) )
    const output = await run_benchmarks( [ `--benchmarks`, `--json` ], {
        load: () => load_benchmarks( options ), providers: async () => new Set( [ `OpenAI` ] ),
    } )
    expect( JSON.parse( output ).models[0].name ).toBe( `safe` )
    expect( output ).not.toContain( `must-not-appear` )
} )

it.skipIf( spawnSync( `flock`, [ `--version` ] ).status !== 0 )( `concurrent processes share one refresh using the kernel lock`, async () => {
    const options = await fixture()
    let requests = 0
    const server = createServer( ( request, response ) => {
        requests++
        setTimeout( () => {
            response.setHeader( `content-type`, `application/json` ); response.end( JSON.stringify( page( [ model( `shared` ) ] ) ) ) 
        }, 80 )
    } )
    await new Promise( resolve => server.listen( 0, `127.0.0.1`, resolve ) )
    const module_url = new URL( `../src/docker/assets/effort/benchmark-cache.mjs`, import.meta.url ).href
    const script = `import { load_benchmarks } from ${ JSON.stringify( module_url ) }; const result = await load_benchmarks({cache_path:process.argv[1],fetch_fn:()=>fetch(process.argv[2])}); console.log(result.models[0].name)`
    const run = () => new Promise( ( resolve, reject ) => {
        const child = spawn( `node`, [ `--input-type=module`, `-e`, script, options.cache_path, `http://127.0.0.1:${ server.address().port }` ], { env: { ...process.env, ...options.env, ARTIFICIAL_ANALYSIS_TTL_MINUTES: `15` }, stdio: [ `ignore`, `pipe`, `pipe` ] } )
        let output = ``
        child.stdout.on( `data`, chunk => {
            output += chunk 
        } )
        child.stderr.on( `data`, chunk => {
            output += chunk 
        } )
        child.on( `error`, reject )
        child.on( `close`, code => code ? reject( new Error( output ) ) : resolve( output.trim() ) )
    } )
    try {
        expect( await Promise.all( [ run(), run(), run() ] ) ).toEqual( [ `shared`, `shared`, `shared` ] )
        expect( requests ).toBe( 1 )
    } finally {
        await new Promise( resolve => server.close( resolve ) )
    }
} )

it( `hosts without flock still write and reuse an atomic cache`, async () => {
    const options = await fixture()
    const original_path = process.env.PATH
    let requests = 0
    const fetch_fn = async () => {
        requests++
        return Response.json( page( [ model( `portable` ) ] ) )
    }
    try {
        process.env.PATH = `/nonexistent-babysit-test-path`
        await load_benchmarks( { ...options, fetch_fn } )
        const second = await load_benchmarks( { ...options, fetch_fn } )
        expect( second.models[0].name ).toBe( `portable` )
        expect( requests ).toBe( 1 )
    } finally {
        if( original_path === undefined ) delete process.env.PATH
        else process.env.PATH = original_path
    }
} )
