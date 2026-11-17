import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BABYSITRC_LOADED_ENV, default_env_exclude, load_babysitrc, normalise_env_exclude, read_babysitrc_groups } from '../src/utils/babysitrc.js'

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

describe( `read_babysitrc_groups`, () => {

    const groups_of = text => read_babysitrc_groups( { path: `rc`, read: () => text } )

    it( `opens a group at each comment after variables, titled by its first line`, () => {
        expect( groups_of( [
            `LOOSE=1`,
            `# Github related stuff`,
            `# tokens and identity`,
            `GH_TOKEN=x`,
            `export GIT_AUTHOR_EMAIL=y`,
            ``,
            `# Gmail auth`,
            `GMAIL_USER=a`,
        ].join( `\n` ) ) ).toEqual( [
            { title: null, default: true, keys: [ `LOOSE` ] },
            { title: `Github related stuff`, default: true, keys: [ `GH_TOKEN`, `GIT_AUTHOR_EMAIL` ] },
            { title: `Gmail auth`, default: true, keys: [ `GMAIL_USER` ] },
        ] )
    } )

    it( `reads # default: false and lists those variables as excluded`, () => {
        const groups = groups_of( `# Apple\n# default: false\nAPPLE_ID=a\nAPPLE_ID_PASSWORD=b\n# Phone\nPHONE=1` )
        expect( groups.map( group => group.default ) ).toEqual( [ false, true ] )
        expect( default_env_exclude( groups ) ).toEqual( [ `APPLE_ID`, `APPLE_ID_PASSWORD` ] )
    } )

    it( `never turns a commented-out assignment into a title, and drops empty groups`, () => {
        const groups = groups_of( `# # Claude setup-token\n# export CLAUDE_CODE_OAUTH_TOKEN=secret\nCLAUDE_LOGIN_EMAIL=z\n# Empty\n` )
        expect( groups ).toEqual( [ { title: `Claude setup-token`, default: true, keys: [ `CLAUDE_LOGIN_EMAIL` ] } ] )
        expect( JSON.stringify( groups ) ).not.toContain( `secret` )
    } )

    it( `lists a variable assigned twice once, and an absent rc as no groups`, () => {
        expect( groups_of( `A=1\nA=2` ) ).toEqual( [ { title: null, default: true, keys: [ `A` ] } ] )
        expect( read_babysitrc_groups( { path: join( tmpdir(), `babysit-missing-rc` ) } ) ).toEqual( [] )
    } )

} )

describe( `normalise_env_exclude`, () => {

    it( `reads comma lists and repeats, keeps an explicit empty list, and refuses non-names`, () => {
        expect( normalise_env_exclude( undefined ) ).toBeNull()
        expect( normalise_env_exclude( `` ) ).toEqual( [] )
        expect( normalise_env_exclude( [ `A,B`, `B C` ] ) ).toEqual( [ `A`, `B`, `C` ] )
        expect( () => normalise_env_exclude( `A,$(rm)` ) ).toThrow( /not one/ )
    } )

} )

describe( `resolve_env_exclude`, () => {

    const groups = () => [ { title: `Apple`, default: false, keys: [ `APPLE_ID` ] } ]

    it( `takes the flag, then the resumed session, then the fork parent, then rc defaults`, async () => {
        const { resolve_env_exclude } = await import( '../src/cli/start.js' )
        const stored = { env_exclude: [ `STORED` ] }
        const fork = { env_exclude: [ `PARENT` ] }

        expect( resolve_env_exclude( { env_exclude: [] }, { stored, fork, groups } ) ).toEqual( [] )
        expect( resolve_env_exclude( { env_exclude: null }, { stored, fork, groups } ) ).toEqual( [ `STORED` ] )
        expect( resolve_env_exclude( {}, { stored: {}, fork, groups } ) ).toEqual( [ `PARENT` ] )
        expect( resolve_env_exclude( {}, { groups } ) ).toEqual( [ `APPLE_ID` ] )
        // Without host context the rc is never mounted
        expect( resolve_env_exclude( { env_exclude: [ `X` ] }, { mode: { ignore_host_agents_md: true }, groups } ) ).toEqual( [] )
    } )

} )
