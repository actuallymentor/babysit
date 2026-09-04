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
    const compose_lines = [
        `services:`,
        `  babysit-web:`,
        `    image: actuallymentor/babysit-web:latest`,
        `    restart: unless-stopped`,
        `    init: true`,
        `    user: "${ uid }:${ gid }"`,
        `    environment:`,
        `      PORT: "3000"`,
        `      BABYSIT_WEB_TRUST_PROXY: "1"`,
        `    expose:`,
        `      - "3000"`,
        `    volumes:`,
        `      - type: bind`,
        `        source: ${ JSON.stringify( paths.access_dir ) }`,
        `        target: /bridge/access`,
        `        read_only: true`,
        `      - type: bind`,
        `        source: ${ JSON.stringify( paths.state ) }`,
        `        target: /bridge/state`,
        `        read_only: true`,
        `      - type: bind`,
        `        source: ${ JSON.stringify( paths.requests ) }`,
        `        target: /bridge/requests`,
        `    read_only: true`,
        `    tmpfs:`,
        `      - /tmp:rw,noexec,nosuid,nodev,size=16m`,
        `    cap_drop:`,
        `      - ALL`,
        `    security_opt:`,
        `      - no-new-privileges:true`,
    ]

    print( `Babysit web bridge initialized.` )
    print( `` )
    print( `Access token (shown once): ${ token }` )
    print( `` )
    print( `Add this service to your Docker Compose stack:` )
    compose_lines.forEach( line => print( line ) )
    print( `` )
    print( `Start it with: docker compose up -d babysit-web` )
    print( `` )
    print( `Never mount ${ paths.inflight } into the web container.` )

}
