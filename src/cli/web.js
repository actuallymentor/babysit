import { initialize_web_bridge } from '../web_bridge/init.js'

/**
 * Initialize or rotate the local filesystem bridge used by babysit-web.
 * @param {Object} cmd - Parsed web command
 * @param {Object} [options]
 * @param {Function} [options.initialize=initialize_web_bridge] - Initializer seam
 * @param {Function} [options.print=console.log] - Output seam
 */
export const cmd_web = async ( cmd, {
    initialize = initialize_web_bridge,
    print = console.log,
} = {} ) => {

    if( cmd.web_verb !== `init` ) throw new Error( `Unknown web command: ${ cmd.web_verb || `(missing)` }` )

    const { token, paths } = initialize()
    const uid = typeof process.getuid === `function` ? process.getuid() : 1_000
    const gid = typeof process.getgid === `function` ? process.getgid() : 1_000

    print( `Babysit web bridge initialized.` )
    print( `` )
    print( `Access token (shown once): ${ token }` )
    print( `` )
    print( `Run actuallymentor/babysit-web as the same host user:` )
    print( `  user: "${ uid }:${ gid }"` )
    print( `  volumes:` )
    print( `    - ${ paths.access }:/bridge/access.json:ro` )
    print( `    - ${ paths.state }:/bridge/state:ro` )
    print( `    - ${ paths.requests }:/bridge/requests:rw` )
    print( `` )
    print( `Never mount ${ paths.inflight } into the web container.` )

}
