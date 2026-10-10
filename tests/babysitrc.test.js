import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BABYSITRC_LOADED_ENV, load_babysitrc } from '../src/utils/babysitrc.js'

const with_rc = ( contents, run ) => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-rc-` ) )
    const path = join( directory, `.babysitrc` )
    writeFileSync( path, contents )
    try {
        return run( path )
    } finally {
        rmSync( directory, { recursive: true, force: true } )
    }
}

describe( `load_babysitrc`, () => {

    it( `merges exported and plain assignments, ignoring rc output`, () => with_rc(
        `echo noisy\nexport PUSHOVER_TOKEN=tok\nPUSHOVER_USER="u s"\nPATH="$PATH:/extra"\n`,
        path => {
            const env = { PATH: `/bin:/usr/bin`, KEEP: `same` }
            const changed = load_babysitrc( { env, path } )
            expect( env.PUSHOVER_TOKEN ).toBe( `tok` )
            expect( env.PUSHOVER_USER ).toBe( `u s` )
            expect( env.PATH ).toBe( `/bin:/usr/bin:/extra` )
            expect( env.KEEP ).toBe( `same` )
            expect( env[ BABYSITRC_LOADED_ENV ] ).toBe( `1` )
            expect( changed.sort() ).toEqual( [ `PATH`, `PUSHOVER_TOKEN`, `PUSHOVER_USER` ] )
        },
    ) )

    it( `sources once per process tree`, () => with_rc( `export X=1\n`, path => {
        const env = { PATH: process.env.PATH, [ BABYSITRC_LOADED_ENV ]: `1` }
        expect( load_babysitrc( { env, path } ) ).toEqual( [] )
        expect( env.X ).toBeUndefined()
    } ) )

    it( `keeps variables set before a failing line`, () => with_rc( `export A=1\nfalse\nexport B=2\n`, path => {
        const env = { PATH: process.env.PATH }
        load_babysitrc( { env, path } )
        expect( [ env.A, env.B ] ).toEqual( [ `1`, `2` ] )
    } ) )

    it( `leaves env untouched when the rc is missing or bash fails`, () => {
        const env = { PATH: process.env.PATH }
        expect( load_babysitrc( { env, path: `/definitely/missing/.babysitrc` } ) ).toEqual( [] )
        expect( env[ BABYSITRC_LOADED_ENV ] ).toBeUndefined()

        with_rc( `exit 3\n`, path => {
            expect( load_babysitrc( { env, path } ) ).toEqual( [] )
            expect( Object.keys( env ).sort() ).toEqual( [ BABYSITRC_LOADED_ENV, `PATH` ] )
        } )
    } )

} )
