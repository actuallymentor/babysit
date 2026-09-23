#!/usr/bin/env node
import { run_effort, run_model, effort_help, model_help } from './command.mjs'
import { run_usage } from '../usage/command.mjs'

try {
    const [ command, ...args ] = process.argv.slice( 2 )
    if( command === `usage` ) process.exitCode = await run_usage( args )
    else if( command === `effort` ) console.log( await run_effort( args ) )
    else if( command === `model` ) console.log( await run_model( args ) )
    else throw new Error( `${ effort_help }\n\n${ model_help }\n\nUsage: babysit usage [--json]` )
} catch ( error ) {
    console.error( `babysit: ${ error.message }` )
    process.exitCode = 1
}
