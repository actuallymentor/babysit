#!/usr/bin/env node
import { run_effort, run_model, run_exit, effort_help, model_help, exit_help } from './command.mjs'
import { run_usage } from '../usage/command.mjs'

try {
    const [ command, ...args ] = process.argv.slice( 2 )
    if( command === `usage` ) process.exitCode = await run_usage( args )
    else if( command === `effort` ) console.log( await run_effort( args ) )
    else if( command === `model` ) console.log( await run_model( args ) )
    else if( command === `exit` ) console.log( await run_exit( args ) )
    else throw new Error( `${ effort_help }\n\n${ model_help }\n\n${ exit_help }\n\nUsage: babysit usage [--json]` )
} catch ( error ) {
    console.error( `babysit: ${ error.message }` )
    process.exitCode = 1
}
