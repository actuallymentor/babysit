#!/usr/bin/env node

import { log } from 'mentie'
import { create_app } from './app.js'
import { read_config } from './config.js'

const config = read_config()
const server = create_app( config )

server.listen( config.port, `0.0.0.0`, () => log.info( `Babysit Web listening on port ${ config.port }` ) )

const shutdown = signal => {
    log.info( `${ signal } received; stopping Babysit Web` )
    server.close( error => {
        if( error ) log.error( `Failed to stop cleanly:`, error )
        process.exitCode = error ? 1 : 0
    } )
}

process.once( `SIGINT`, () => shutdown( `SIGINT` ) )
process.once( `SIGTERM`, () => shutdown( `SIGTERM` ) )
