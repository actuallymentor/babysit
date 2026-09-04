import { describe, expect, it } from 'bun:test'

import { cmd_web } from '../src/cli/web.js'

describe( `babysit web init`, () => {

    it( `prints the token once and safe Compose mount guidance`, async () => {
        const lines = []
        const paths = {
            access_dir: `/host/web/access`,
            access: `/host/web/access/access.json`,
            state: `/host/web/state`,
            requests: `/host/web/requests`,
            inflight: `/host/web/inflight`,
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
        expect( output ).toContain( `source: "${ paths.access_dir }"` )
        expect( output ).toContain( `source: "${ paths.state }"` )
        expect( output ).toContain( `source: "${ paths.requests }"` )
        expect( output ).toContain( `docker compose up -d babysit-web` )
        expect( output ).not.toContain( `docker run` )
        expect( output ).not.toContain( `${ paths.inflight }:/bridge/inflight` )
        expect( output ).toContain( `Never mount ${ paths.inflight }` )
    } )

} )
