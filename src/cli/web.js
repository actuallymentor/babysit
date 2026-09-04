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
    const compose_path = path => JSON.stringify( path.replaceAll( `$`, () => `$$` ) )
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
        `      BABYSIT_WEB_PUBLIC_ORIGIN: "\${BABYSIT_WEB_PUBLIC_ORIGIN:?Set the public HTTPS origin}"`,
        `    expose:`,
        `      - "3000"`,
        `    volumes:`,
        `      - type: bind`,
        `        source: ${ compose_path( paths.access_dir ) }`,
        `        target: /bridge/access`,
        `        read_only: true`,
        `        bind:`,
        `          create_host_path: false`,
        `      - type: bind`,
        `        source: ${ compose_path( paths.state ) }`,
        `        target: /bridge/state`,
        `        read_only: true`,
        `        bind:`,
        `          create_host_path: false`,
        `      - type: bind`,
        `        source: ${ compose_path( paths.requests ) }`,
        `        target: /bridge/requests`,
        `        bind:`,
        `          create_host_path: false`,
        `    read_only: true`,
        `    tmpfs:`,
        `      - /tmp:rw,noexec,nosuid,nodev,size=16m`,
        `    cap_drop:`,
        `      - ALL`,
        `    security_opt:`,
        `      - no-new-privileges:true`,
        `    pids_limit: 100`,
        `    healthcheck:`,
        `      test: [ "CMD", "node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))" ]`,
        `      interval: 30s`,
        `      timeout: 5s`,
        `      retries: 3`,
        `      start_period: 10s`,
        `    networks:`,
        `      - proxy`,
        ``,
        `networks:`,
        `  proxy:`,
        `    external: true`,
        `    name: "\${BABYSIT_WEB_PROXY_NETWORK:-proxy}"`,
    ]

    print( `Babysit web bridge initialized.` )
    print( `` )
    print( `Access token (shown once): ${ token }` )
    print( `` )
    print( `Add this service to your Docker Compose stack:` )
    compose_lines.forEach( line => print( line ) )
    print( `` )
    print( `Set BABYSIT_WEB_PUBLIC_ORIGIN and, if needed, BABYSIT_WEB_PROXY_NETWORK.` )
    print( `Start it with: docker compose up -d babysit-web` )
    print( `` )
    print( `Never mount ${ paths.inflight } into the web container.` )

}
