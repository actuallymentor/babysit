import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const helper = new URL( `../src/docker/assets/antigravity-auth.py`, import.meta.url ).pathname
const homes = []
afterEach( () => homes.splice( 0 ).forEach( home => rmSync( home, { recursive: true, force: true } ) ) )

const fixture = ( { persisted, seed, key } = {} ) => {

    const home = mkdtempSync( join( tmpdir(), `babysit-antigravity-bootstrap-` ) )
    homes.push( home )
    const settings = join( home, `.gemini/antigravity-cli/settings.json` )
    const source = join( home, `.babysit-antigravity-settings.json` )
    mkdirSync( dirname( settings ), { recursive: true } )
    if( persisted !== undefined ) writeFileSync( settings, typeof persisted === `string` ? persisted : JSON.stringify( persisted ) )
    if( seed !== undefined ) writeFileSync( source, typeof seed === `string` ? seed : JSON.stringify( seed ) )
    const env = { ...process.env, HOME: home }
    delete env.GEMINI_API_KEY
    if( key ) env.GEMINI_API_KEY = key

    return {
        settings,
        read: () => JSON.parse( readFileSync( settings, `utf8` ) ),
        run: ( args = [ `agy` ] ) => spawnSync( `python3`, [ helper, ...args ], { env, encoding: `utf8`, timeout: 5000 } ),
    }

}

describe( `Antigravity container settings bootstrap`, () => {

    it( `preserves native trust while replacing old preferences with the host seed`, () => {
        const trustedWorkspaces = [ `/workspace` ]
        const f = fixture( {
            persisted: { trustedWorkspaces, theme: `old`, model: `old-model`, stalePreference: true },
            seed: { theme: `new`, model: `new-model`, trustedWorkspaces: [ `/workspace`, `/host-only` ] },
        } )
        expect( f.run().status ).toBe( 0 )
        expect( f.read() ).toEqual( { theme: `new`, model: `new-model`, trustedWorkspaces: [ `/workspace`, `/host-only` ] } )
    } )

    it( `selects the Gemini API provider when the loaded environment contains a key`, () => {
        const f = fixture( {
            persisted: { trustedWorkspaces: [ `/workspace` ] },
            seed: { modelProvider: `antigravity`, theme: `light` },
            key: `fixture-secret`,
        } )
        const result = f.run()
        expect( result.status ).toBe( 0 )
        expect( f.read() ).toEqual( { modelProvider: `gemini`, theme: `light`, trustedWorkspaces: [ `/workspace` ] } )
        expect( readFileSync( f.settings, `utf8` ) ).not.toContain( `fixture-secret` )
        expect( result.stdout + result.stderr ).not.toContain( `fixture-secret` )
    } )

    it( `can select the API provider without a staged host seed`, () => {
        const f = fixture( { persisted: { model: `saved-model` }, key: `fixture-secret` } )
        expect( f.run().status ).toBe( 0 )
        expect( f.read() ).toEqual( { model: `saved-model`, modelProvider: `gemini` } )
    } )

    it( `leaves settings untouched without a seed or API key`, () => {
        const raw = `{ "model": "saved-model" }\n`
        const f = fixture( { persisted: raw } )
        expect( f.run().status ).toBe( 0 )
        expect( readFileSync( f.settings, `utf8` ) ).toBe( raw )
        const empty = fixture()
        expect( empty.run().status ).toBe( 0 )
        expect( existsSync( empty.settings ) ).toBe( false )
    } )

    it( `fails primary Antigravity launches on malformed settings while other agents still start`, () => {
        for( const args of [ [ `agy` ], [ `python3`, `/home/node/.babysit-capture/capture.py`, `launch`, `antigravity`, `agy` ] ] ) {
            const f = fixture( { persisted: `{broken`, seed: { theme: `light` } } )
            const result = f.run( args )
            expect( result.status ).not.toBe( 0 )
            expect( result.stderr ).not.toBe( `` )
            expect( readFileSync( f.settings, `utf8` ) ).toBe( `{broken` )
        }
        const secondary = fixture( { persisted: `{broken`, key: `fixture-secret` } )
        expect( secondary.run( [ `codex` ] ).status ).toBe( 0 )
        expect( readFileSync( secondary.settings, `utf8` ) ).toBe( `{broken` )
    } )

} )
