import { describe, it, expect } from 'bun:test'

const import_paths = () => import( `../src/utils/paths.js?test=${ Date.now() }-${ Math.random() }` )

describe( `paths`, () => {

    it( `uses the default Babysit tmux socket`, async () => {
        const previous = process.env.BABYSIT_TMUX_SOCKET
        delete process.env.BABYSIT_TMUX_SOCKET

        try {
            const { TMUX_SOCKET } = await import_paths()
            expect( TMUX_SOCKET ).toBe( `babysit` )
        } finally {
            if( previous === undefined ) delete process.env.BABYSIT_TMUX_SOCKET
            else process.env.BABYSIT_TMUX_SOCKET = previous
        }
    } )

    it( `can isolate tmux sockets for E2E runs`, async () => {
        const previous = process.env.BABYSIT_TMUX_SOCKET
        process.env.BABYSIT_TMUX_SOCKET = `babysit-e2e-test`

        try {
            const { TMUX_SOCKET } = await import_paths()
            expect( TMUX_SOCKET ).toBe( `babysit-e2e-test` )
        } finally {
            if( previous === undefined ) delete process.env.BABYSIT_TMUX_SOCKET
            else process.env.BABYSIT_TMUX_SOCKET = previous
        }
    } )

} )
