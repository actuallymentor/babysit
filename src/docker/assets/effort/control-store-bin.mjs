import { control_store } from './control-store.mjs'

// Keep executable entry points out of imported modules: compiled Bun binaries
// share import.meta.url with their entry point and would execute both mains.
try {
    const input = JSON.parse( Buffer.from( process.argv[2], `base64` ).toString( `utf8` ) )
    process.stdout.write( Buffer.from( JSON.stringify( control_store( input ) ) ).toString( `base64` ) )
} catch ( error ) {
    process.stderr.write( `${ error.message }\n` )
    process.exitCode = 1
}
