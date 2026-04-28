import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { build_claude_settings_tmpfile, write_loop_deadline, LOOP_DEADLINE_PATH } from '../src/statusline/render.js'

describe( `build_claude_settings_tmpfile`, () => {

    let dir

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-statusline-` ) )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `creates a tmpfile with statusLine when host settings.json is missing`, () => {

        const host_path = join( dir, `nonexistent.json` )
        const tmpfile = build_claude_settings_tmpfile( host_path )

        expect( tmpfile ).toBeTruthy()
        expect( existsSync( tmpfile ) ).toBe( true )

        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )
        expect( settings.statusLine ).toEqual( {
            type: `command`,
            command: `bash /usr/local/bin/statusline.sh`,
        } )

        rmSync( tmpfile )

    } )

    it( `merges host settings with statusLine`, () => {

        const host_path = join( dir, `settings.json` )
        writeFileSync( host_path, JSON.stringify( { theme: `dark`, model: `sonnet` } ) )

        const tmpfile = build_claude_settings_tmpfile( host_path )
        const settings = JSON.parse( readFileSync( tmpfile, `utf-8` ) )

        expect( settings.theme ).toBe( `dark` )
        expect( settings.model ).toBe( `sonnet` )
        expect( settings.statusLine.command ).toBe( `bash /usr/local/bin/statusline.sh` )

        rmSync( tmpfile )

    } )

    it( `does not mutate the host settings file`, () => {

        const host_path = join( dir, `settings.json` )
        const original = { theme: `light`, statusLine: `something else` }
        writeFileSync( host_path, JSON.stringify( original ) )

        build_claude_settings_tmpfile( host_path )

        const after = JSON.parse( readFileSync( host_path, `utf-8` ) )
        expect( after ).toEqual( original )

    } )

} )

describe( `write_loop_deadline`, () => {

    it( `exports the deadline path constant`, () => {
        expect( LOOP_DEADLINE_PATH ).toBe( `/tmp/babysit-loop-deadline` )
    } )

    it( `writes a number to the deadline file`, () => {
        write_loop_deadline( 1234567890 )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `1234567890` )
    } )

    it( `writes "idle" sentinel to the deadline file`, () => {
        write_loop_deadline( `idle` )
        const content = readFileSync( LOOP_DEADLINE_PATH, `utf-8` )
        expect( content ).toBe( `idle` )
    } )

} )
