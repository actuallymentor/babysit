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
        expect( output ).toContain( `user: "${ process.getuid() }:${ process.getgid() }"` )
        expect( output ).toContain( `${ paths.access_dir }:/bridge/access:ro` )
        expect( output ).toContain( `${ paths.state }:/bridge/state:ro` )
        expect( output ).toContain( `${ paths.requests }:/bridge/requests:rw` )
        expect( output ).not.toContain( `${ paths.inflight }:/bridge/inflight` )
        expect( output ).toContain( `Never mount ${ paths.inflight }` )
    } )

} )
