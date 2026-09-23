import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec_file = promisify( execFile )

/** Parse the native tab-delimited catalog; effort belongs to each advertised model ID. */
export const parse_agy_models = output => output.split( /\r?\n/ ).flatMap( line => {
    const match = line.match( /^([^\s]+)\t+(.+?)\s*$/ )
    if( !match ) return []
    const [ , id, name ] = match
    const effort = id.match( /-(low|medium|high)$/ )?.[1]
    return [ { id, name, effort, family: effort ? id.slice( 0, -effort.length - 1 ) : id } ]
} )

/** Ask the installed authenticated CLI for its current catalog without starting inference. */
export const agy_catalog = async () => {
    let output
    try {
        output = await exec_file( `agy`, [ `models` ], { timeout: 20_000, maxBuffer: 1024 * 1024 } )
    } catch {
        // Native errors may include account details; callers only need the action to take.
        throw new Error( `Cannot read Antigravity models. Check 'agy models' and native authentication in this environment.` )
    }
    const models = parse_agy_models( output.stdout )
    if( !models.length ) throw new Error( `Antigravity did not return a supported model catalog. Check 'agy models'.` )
    return { models }
}

/** Resolve exact native slugs or display labels without inventing effort combinations. */
export const resolve_agy_model = async name => {
    const { models } = await agy_catalog()
    const target = models.find( model => model.id === name || model.name === name )
    if( !target ) throw new Error( `Unsupported Antigravity model '${ name }'. Run babysit model to list available models.` )
    return { ...target, efforts: models.filter( model => model.family === target.family ).map( model => model.effort ).filter( Boolean ) }
}
