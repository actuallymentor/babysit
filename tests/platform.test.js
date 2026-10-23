import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { detect_mode, is_babysit_container } from '../src/utils/platform.js'

const helper = fileURLToPath( new URL( `../src/docker/assets/effort/bin.mjs`, import.meta.url ) )

describe( `babysit mode detection`, () => {

    it( `reports container when the launch env is present`, () => {
        const env = { BABYSIT_MODIFIERS: `yolo·docker` }
        expect( is_babysit_container( { env } ) ).toBe( true )
        expect( detect_mode( { env } ) ).toBe( `container` )
    } )

    it( `reports host without the babysit launch env`, () => {
        expect( is_babysit_container( { env: {} } ) ).toBe( false )
        expect( detect_mode( { env: {} } ) ).toBe( `host` )
    } )

    it( `ignores babysit env vars other than the launch label`, () => {
        // Other babysit env vars leak into host shells (rc files, sudo toggles); only the launch label counts
        const env = { BABYSIT_DOCKER_USE_SUDO: `1`, BABYSIT_HOST_BABYSITRC: `/home/me/.babysitrc` }
        expect( detect_mode( { env } ) ).toBe( `host` )
    } )

    it( `in-container helper always answers container`, () => {
        const result = spawnSync( process.execPath, [ helper, `mode` ], { encoding: `utf8`, env: {} } )
        expect( result.status ).toBe( 0 )
        expect( result.stdout.trim() ).toBe( `container` )
    } )

} )
