#!/usr/bin/env node
import { run_usage } from './command.mjs'

try {
    process.exitCode = await run_usage( process.argv.slice( 2 ) )
} catch ( error ) {
    process.stderr.write( `${ error.message }\n` )
    process.exitCode = 1
}
