import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

import { cmd_web } from '../src/cli/web.js'

describe( `babysit web init`, () => {

    it( `prints the token once and safe Compose mount guidance`, async () => {
        const lines = []
        const paths = {
            access_dir: `/host/$account/web/access`,
            access: `/host/$account/web/access/access.json`,
            state: `/host/$account/web/state`,
            requests: `/host/$account/web/requests`,
            inflight: `/host/$account/web/inflight`,
        }

        await cmd_web( { web_verb: `init` }, {
            initialize: () => ( { token: `one-time-token`, paths } ),
            print: line => lines.push( line ),
        } )

        const output = lines.join( `\n` )
        expect( output.match( /one-time-token/g ) ).toHaveLength( 1 )
        expect( output ).toContain( `Add this service to your Docker Compose stack:` )
        expect( output ).toContain( `services:\n  babysit-web:` )
        expect( output ).toContain( `image: actuallymentor/babysit-web:latest` )
        expect( output ).toContain( `user: "${ process.getuid() }:${ process.getgid() }"` )
        expect( output ).toContain( `source: "/host/$$account/web/access"` )
        expect( output ).toContain( `source: "/host/$$account/web/state"` )
        expect( output ).toContain( `source: "/host/$$account/web/requests"` )
        expect( output ).toContain( `BABYSIT_WEB_PUBLIC_ORIGIN: "\${BABYSIT_WEB_PUBLIC_ORIGIN:?Set the public HTTPS origin}"` )
        expect( output ).toContain( `name: "\${BABYSIT_WEB_PROXY_NETWORK:-proxy}"` )
        expect( output ).toContain( `docker compose up -d babysit-web` )
        expect( output ).not.toContain( `docker run` )
        expect( output ).not.toContain( `${ paths.inflight }:/bridge/inflight` )
        expect( output ).toContain( `Never mount ${ paths.inflight }` )

        const compose_start = output.indexOf( `services:` )
        const compose_end = output.indexOf( `\n\nSet BABYSIT_WEB_PUBLIC_ORIGIN`, compose_start )
        const compose = parse( output.slice( compose_start, compose_end ) )
        expect( compose.services[ `babysit-web` ].networks ).toEqual( [ `proxy` ] )
        expect( compose.networks.proxy.external ).toBe( true )
    } )

    it( `keeps the production and local Compose examples structurally valid`, () => {
        const production = parse( readFileSync( new URL( `../examples/compose.web.yml`, import.meta.url ), `utf8` ) )
        const local = parse( readFileSync( new URL( `../examples/compose.web.local.yml`, import.meta.url ), `utf8` ) )

        expect( production.services[ `babysit-web` ].networks ).toEqual( [ `proxy` ] )
        expect( production.networks.proxy.external ).toBe( true )
        expect( production.services[ `babysit-web` ].environment.BABYSIT_WEB_PUBLIC_ORIGIN ).toContain( `:?Set the public HTTPS origin` )
        expect( production.services[ `babysit-web` ].volumes ).toHaveLength( 3 )
        expect( production.services[ `babysit-web` ].volumes.every( ( { source } ) => source.includes( `BABYSIT_WEB_BRIDGE_DIR` ) ) ).toBe( true )
        expect( local.services[ `babysit-web` ].ports ).toEqual( [ `127.0.0.1:3000:3000` ] )
        expect( local.services[ `babysit-web` ].environment.BABYSIT_WEB_ALLOW_INSECURE_HTTP ).toBe( `1` )
        expect( local.services[ `babysit-web` ].volumes ).toHaveLength( 3 )
        expect( local.services[ `babysit-web` ].volumes.every( ( { source } ) => source.includes( `BABYSIT_WEB_BRIDGE_DIR` ) ) ).toBe( true )
    } )

} )
