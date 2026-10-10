#!/usr/bin/env node
import { run_effort, run_model, run_exit, run_stuck, run_loop, effort_help, model_help, exit_help, stuck_help, loop_help } from './command.mjs'
import { run_usage, usage_help } from '../usage/command.mjs'

const HELP = { effort: effort_help, model: model_help, exit: exit_help, stuck: stuck_help, loop: loop_help, usage: usage_help }
const ALL_HELP = `In-session Babysit commands (host-only commands such as list or resume run outside the container).\n\n${ Object.values( HELP ).join( `\n\n` ) }`

try {
    const [ command, ...args ] = process.argv.slice( 2 )
    // `babysit help [command]` and a bare `--help` explain; other misuse still fails below
    if( [ `help`, `--help`, `-h` ].includes( command ) ) console.log( HELP[ args[0] ] || ALL_HELP )
    else if( command === `usage` ) process.exitCode = await run_usage( args )
    else if( command === `effort` ) console.log( await run_effort( args ) )
    else if( command === `model` ) console.log( await run_model( args ) )
    else if( command === `exit` ) console.log( await run_exit( args ) )
    else if( command === `stuck` ) console.log( await run_stuck( args ) )
    else if( command === `loop` ) console.log( await run_loop( args ) )
    else throw new Error( ALL_HELP )
} catch ( error ) {
    console.error( `babysit: ${ error.message }` )
    process.exitCode = 1
}
