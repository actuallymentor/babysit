import { createHash } from 'crypto'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { resolve, join } from 'path'
import { hostname } from 'os'
import { run } from '../utils/exec.js'
import { docker_command_prefix } from '../docker/run.js'
import { session_workspace } from './store.js'

export const RECOVERY_PROMPT = `You were interrupted. Check the current state, then continue unfinished work.`

/** Resolve one lifecycle lock for all launch aliases sharing an agent workspace. */
export const session_lock_key = session => {

    const workspace = session_workspace( session ) || process.cwd()
    const canonical = existsSync( workspace ) ? realpathSync( workspace ) : resolve( workspace )
    return `${ session.agent }:${ canonical }`

}

/** Fingerprint configuration without copying commands or embedded secrets into metadata. */
export const workspace_config_hash = workspace => {

    const path = join( workspace, `babysit.yaml` )
    return existsSync( path ) ? createHash( `sha256` ).update( readFileSync( path ) ).digest( `hex` ) : null

}

/** Identify the Docker daemon, including remote contexts, without persisting credentials. */
export const docker_identity = async () => {

    const [ command, ...prefix ] = docker_command_prefix()
    const id = await run( command, [ ...prefix, `info`, `--format`, `{{.ID}}` ], {}, 15_000 )
    if( !id ) throw new Error( `Docker did not provide its identity` )
    return { host: hostname(), docker_id: id }

}

/** Read the immutable image actually used by a container. */
export const container_image = async container => {

    const [ command, ...prefix ] = docker_command_prefix()
    return run( command, [ ...prefix, `inspect`, `--format`, `{{.Image}}`, container ], {}, 15_000 )

}

/**
 * Preserve supported execution options; unknown flags block automatic replay.
 * Never save positional prompts or arbitrary flags that may contain secrets.
 */
export const recovery_arguments = ( agent, args = [], mode = {} ) => {

    const allowed = new Set( [ `--model`, ... agent.name === `claude` ? [] : [ `-m` ] , `--effort`, `--variant` ] )
    const saved = []
    let unsupported = false
    for( let index = 0; index < args.length; index++ ) {
        const argument = args[ index ]
        const [ name, ...values ] = argument.split( `=` )
        if( !allowed.has( name ) ) {
            unsupported = true
            continue
        }
        const value = values.length ? values.join( `=` ) : args[ ++index ]
        if( !value || value.startsWith( `-` ) ) {
            unsupported = true
            continue
        }
        saved.push( name, value )
    }

    if( !saved.includes( `--model` ) && !saved.includes( `-m` ) ) {
        const model = typeof agent.defaults?.model === `function`
            ? agent.defaults.model( { agent_args: args, mode } )
            : agent.defaults?.model
        if( model ) saved.push( `--model`, model )
    }

    if( agent.name === `claude` && agent.defaults?.effort && !saved.includes( `--effort` ) ) saved.push( `--effort`, agent.defaults.effort )

    return { args: saved, unsupported }

}

/** Select only the newest durable launch in a resume chain. */
export const recovery_candidates = sessions => {

    const superseded = new Set( sessions.map( session => session.resumed_from ).filter( Boolean ) )
    return sessions.filter( session => !superseded.has( session.babysit_id ) && !session.superseded_by )

}

/** Keep an original Babysit ID useful after recovery creates replacement launches. */
export const select_recovery_sessions = ( sessions, id = null ) => {

    const candidates = recovery_candidates( sessions )
    if( !id ) return candidates
    const by_id = new Map( sessions.map( session => [ session.babysit_id, session ] ) )
    return candidates.filter( candidate => {
        const seen = new Set()
        let current = candidate
        while( current && !seen.has( current.babysit_id ) ) {
            if( current.babysit_id === id ) return true
            seen.add( current.babysit_id )
            current = by_id.get( current.resumed_from )
        }
        return false
    } )

}
