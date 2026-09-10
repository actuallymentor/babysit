import { describe, it, expect } from 'bun:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolve_babysit_home } from '../src/utils/paths.js'

const import_paths = () => import( `../src/utils/paths.js?test=${ Date.now() }-${ Math.random() }` )

describe( `paths`, () => {

    it( `defaults to the account home and rejects cwd-dependent overrides`, () => {
        expect( resolve_babysit_home( `/home/test`, `` ) ).toBe( `/home/test/.babysit` )
        expect( resolve_babysit_home( `/home/test`, `/mnt/state/../babysit` ) ).toBe( `/mnt/babysit` )
        for( const value of [ `relative`, `~/state`, ` `, `/tmp/state\n`, `/tmp/\0state` ] ) {
            expect( () => resolve_babysit_home( `/home/test`, value ) ).toThrow( `BABYSIT_HOME must be an absolute path` )
        }
    } )

    it( `uses a custom home for real CLI writes and derived storage paths`, () => {
        const root = mkdtempSync( join( tmpdir(), `babysit-home-` ) )
        const home = join( root, `account` )
        const state = join( root, `custom state` )
        const env = { ...process.env, HOME: home, BABYSIT_HOME: state, BABYSIT_WEB_BRIDGE_DIR: `` }

        try {
            execFileSync( `node`, [ `src/index.js`, `config`, `--auth-check-agents=none` ], { env } )
            expect( existsSync( join( state, `config.json` ) ) ).toBe( true )
            expect( existsSync( join( home, `.babysit` ) ) ).toBe( false )

            const script = `
                import { BABYSIT_DIR, SESSIONS_DIR, CLONES_DIR, CREDENTIAL_RECOVERY_DIR } from './src/utils/paths.js'
                import { WEB_BRIDGE_DIR } from './src/web_bridge/paths.js'
                console.log(JSON.stringify([BABYSIT_DIR, SESSIONS_DIR, CLONES_DIR, CREDENTIAL_RECOVERY_DIR, WEB_BRIDGE_DIR]))
            `
            const paths = JSON.parse( execFileSync( `node`, [ `--input-type=module`, `-e`, script ], { env, encoding: `utf8` } ) )
            expect( paths ).toEqual( [ state, ...[ `sessions`, `clones`, `credential-recovery`, `web-bridge` ].map( name => join( state, name ) ) ] )
            const overridden = JSON.parse( execFileSync( `node`, [ `--input-type=module`, `-e`, script ], {
                env: { ...env, BABYSIT_WEB_BRIDGE_DIR: join( root, `bridge` ) }, encoding: `utf8`,
            } ) )
            expect( overridden[ 4 ] ).toBe( join( root, `bridge` ) )

            const invalid = spawnSync( `node`, [ `src/index.js`, `config` ], {
                env: { ...env, BABYSIT_HOME: `relative` }, encoding: `utf8`,
            } )
            expect( invalid.status ).not.toBe( 0 )
            expect( invalid.stderr ).toContain( `BABYSIT_HOME must be an absolute path` )
        } finally {
            rmSync( root, { recursive: true, force: true } )
        }
    } )

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
