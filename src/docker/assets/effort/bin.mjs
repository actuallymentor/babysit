#!/usr/bin/env node
import { run_effort, effort_help } from './command.mjs'

try {
    const [ command, ...args ] = process.argv.slice( 2 )
    if( command !== `effort` ) throw new Error( effort_help )
    console.log( await run_effort( args ) )
} catch ( error ) {
    console.error( `babysit: ${ error.message }` )
    process.exitCode = 1
}
