import { load_benchmarks } from './benchmark-cache.mjs'
import { benchmark_providers } from './benchmark-providers.mjs'

export const benchmarks_help = `Usage: babysit model --benchmarks [--sort <field>] [--limit <N>] [--all] [--json]
Sort: coding (default), intelligence, agentic, cost, cost-per-point, name.
Cost = intelligence benchmark USD/task; cost-per-point = cost / intelligence.
Rows from locally authenticated CLI providers are shown; missing metrics print as — and sort last.
--all is accepted for compatibility and changes nothing. --limit is a positive integer; omitted means all rows.
ARTIFICIAL_ANALYSIS_API_KEY is required. ARTIFICIAL_ANALYSIS_TTL_MINUTES defaults to 15; 0 disables caching.`

const sort_fields = { coding: `coding`, intelligence: `intelligence`, agentic: `agentic`, cost: `cost`, 'cost-per-point': `cost_per_point`, name: `name` }

/** Parse only benchmark flags; never reinterpret a model-switch request. */
export const parse_benchmarks = args => {
    const options = { sort: `coding`, limit: Infinity, json: false }
    for( let index = 0; index < args.length; index++ ) {
        const argument = args[index]
        if( argument === `--benchmarks` ) continue
        if( [ `--help`, `-h` ].includes( argument ) ) return { help: true }
        // --all once included rows with missing metrics; that is now the only behaviour.
        if( argument === `--all` ) continue
        if( argument === `--json` ) options.json = true
        else if( argument === `--sort` ) {
            options.sort = args[++index]
            if( !Object.hasOwn( sort_fields, options.sort ) ) throw new Error( benchmarks_help )
        } else if( argument === `--limit` ) {
            const value = args[++index]
            if( !/^[1-9]\d*$/.test( value ) || !Number.isSafeInteger( Number( value ) ) ) throw new Error( `--limit must be a positive integer` )
            options.limit = Number( value )
        } else throw new Error( benchmarks_help )
    }
    return options
}

/** Apply local access before sorting and limiting the shared data; missing metrics stay visible. */
export const select_benchmarks = ( models, providers, { sort = `coding`, limit = Infinity } = {} ) => {
    const field = sort_fields[sort]
    const ascending = [ `cost`, `cost_per_point`, `name` ].includes( field )
    return models.filter( model => providers.has( model.provider ) )
        .sort( ( a, b ) => {
            if( a[field] === null && b[field] !== null ) return 1
            if( b[field] === null && a[field] !== null ) return -1
            const order = field === `name` ? a.name.localeCompare( b.name ) : ( a[field] ?? 0 ) - ( b[field] ?? 0 )
            return ( ascending ? order : -order ) || a.name.localeCompare( b.name ) || a.id.localeCompare( b.id )
        } ).slice( 0, limit )
}

const safe_text = value => String( value ).replace( /[\x00-\x1f\x7f-\x9f]/g, `` )
const number = ( value, digits ) => value === null ? `—` : value.toFixed( digits )

/** Plain terminal table; preserve the provider's full variant/effort label. */
export const format_benchmarks = report => {
    if( !report.models.length ) return `No matching benchmarks; check CLI authentication.`
    const rows = [ [ `Model`, `Provider`, `Intelligence`, `Coding`, `Agentic`, `$/task`, `$/point` ],
        ...report.models.map( model => [ safe_text( model.name ), safe_text( model.provider ),
            number( model.intelligence, 1 ), number( model.coding, 1 ), number( model.agentic, 1 ), number( model.cost, 4 ), number( model.cost_per_point, 6 ),
        ] ),
    ]
    const widths = rows[0].map( ( _, index ) => Math.max( ...rows.map( row => row[index].length ) ) )
    return [ `Artificial Analysis · sorted by ${ report.sort } · ${ report.models.length }/${ report.total } rows${ report.stale ? ` · stale` : `` }`,
        ...rows.map( row => row.map( ( value, index ) => index < 2 ? value.padEnd( widths[index] ) : value.padStart( widths[index] ) ).join( `  ` ) ),
        `$/task: intelligence benchmark cost. $/point: $/task ÷ intelligence. —: unavailable.`,
    ].join( `\n` )
}

/** Benchmark listing does not require an active model-control session. */
export const run_benchmarks = async ( args, { load = load_benchmarks, providers = benchmark_providers } = {} ) => {
    const options = parse_benchmarks( args )
    if( options.help ) return benchmarks_help
    const snapshot = await load()
    const allowed = await providers()
    const selected = select_benchmarks( snapshot.models, allowed, { ...options, limit: Infinity } )
    const report = {
        fetched_at: new Date( snapshot.fetched_at ).toISOString(),
        index_version: snapshot.index_version, stale: !!snapshot.stale,
        sort: options.sort, total: selected.length, models: selected.slice( 0, options.limit ),
    }
    return options.json ? JSON.stringify( report, null, 2 ) : format_benchmarks( report )
}
