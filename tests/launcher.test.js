import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { launch_menu } from '../src/cli/launcher.js'
import { parse_args } from '../src/cli/parse.js'
import { read_launch_defaults, save_launch_defaults } from '../src/babysit/launch_defaults.js'

const down = `\x1b[B`
const up = `\x1b[A`
const right = `\x1b[C`
const left = `\x1b[D`
let root
let options

beforeEach( () => {

    root = mkdtempSync( join( tmpdir(), `babysit-launcher-` ) )
    const cwd = join( root, `project` )
    mkdirSync( cwd )
    options = { cwd, defaults_path: join( root, `defaults.json` ) }

} )

afterEach( () => rmSync( root, { recursive: true, force: true } ) )

const open_menu = async ( extra = {}, { raw = false, flowing = false } = {} ) => {

    const input = new PassThrough()
    const output = new PassThrough()
    const raw_modes = []
    let rendered = ``

    input.isTTY = true
    input.isRaw = raw
    input.setRawMode = raw => {
        input.isRaw = raw
        raw_modes.push( raw )
    }
    output.isTTY = true
    output.columns = 100
    output.on( `data`, chunk => rendered += chunk.toString() )
    if( flowing ) input.resume()

    const result = launch_menu( { ...options, input, output, ...extra } )

    // Wait for input ownership, then send terminal bytes through readline itself.
    for( let attempt = 0; !input.isRaw && attempt < 100; attempt++ ) {
        await new Promise( resolve => setImmediate( resolve ) )
    }
    expect( input.isRaw ).toBe( true )

    return { input, output, raw_modes, result, rendered: () => rendered }

}

describe( `launcher routing`, () => {

    it( `opens bare and named launches while preserving explicit commands`, () => {

        expect( parse_args( [] ).verb ).toBe( `launch` )
        expect( parse_args( [ `fix the dashboard` ] ) ).toMatchObject( {
            verb: `launch`, flags: { name: `fix the dashboard` },
        } )
        expect( parse_args( [ `constructor` ] ) ).toMatchObject( {
            verb: `launch`, flags: { name: `constructor` },
        } )
        expect( parse_args( [ `codex` ] ) ).toMatchObject( { verb: `start`, agent: `codex` } )
        expect( parse_args( [ `resume` ] ).verb ).toBe( `resume` )
        expect( parse_args( [ `list` ] ).verb ).toBe( `list` )
        expect( parse_args( [ `fix`, `--yolo` ] ).verb ).toBe( `help` )

    } )

} )

describe( `launch defaults`, () => {

    it( `remembers each project and uses the latest launch for unknown projects`, async () => {

        const other = { ...options, cwd: join( root, `other` ) }
        const unknown = { ...options, cwd: join( root, `unknown` ) }
        mkdirSync( other.cwd )
        mkdirSync( unknown.cwd )

        await save_launch_defaults( parse_args( [ `codex`, `--docker`, `--yolo`, `--name`, `private name` ] ), options )
        await save_launch_defaults( parse_args( [ `gemini`, `--sandbox`, `--loop` ] ), other )

        expect( await read_launch_defaults( options ) ).toMatchObject( {
            agent: `codex`, docker: true, yolo: true, clone: false, loop: false, mode: `regular`,
        } )
        expect( await read_launch_defaults( unknown ) ).toEqual( await read_launch_defaults( other ) )
        expect( await read_launch_defaults( other ) ).toMatchObject( { agent: `gemini`, mode: `sandbox`, loop: true } )
        expect( readFileSync( options.defaults_path, `utf8` ) ).not.toContain( `private name` )

    } )

    it( `recognizes a project through a symlink`, async () => {

        const alias = join( root, `alias` )
        symlinkSync( options.cwd, alias )
        await save_launch_defaults( parse_args( [ `opencode`, `--clone` ] ), options )
        const other = { ...options, cwd: join( root, `other` ) }
        mkdirSync( other.cwd )
        await save_launch_defaults( parse_args( [ `claude` ] ), other )

        expect( await read_launch_defaults( { ...options, cwd: alias } ) ).toMatchObject( {
            agent: `opencode`, clone: true,
        } )

    } )

    it( `recovers from corrupt preferences with usable built-in defaults`, async () => {

        const defaults = await read_launch_defaults( options )
        writeFileSync( options.defaults_path, `{broken` )
        expect( await read_launch_defaults( options ) ).toEqual( defaults )

    } )

    it( `rejects malformed saved fields and conflicting clone modes`, () => {

        const defaults = read_launch_defaults( options )
        writeFileSync( options.defaults_path, JSON.stringify( { global: {
            agent: `unknown`, mode: `invalid`, docker: `true`, yolo: 1, loop: {}, clone: [],
        } } ) )
        expect( read_launch_defaults( options ) ).toEqual( defaults )

        writeFileSync( options.defaults_path, JSON.stringify( { global: {
            agent: `codex`, mode: `mudbox`, clone: true, yolo: true,
        } } ) )
        expect( read_launch_defaults( options ) ).toMatchObject( {
            agent: `codex`, mode: `mudbox`, clone: false, yolo: true,
        } )

    } )

} )

describe( `interactive launch menu`, () => {

    it( `accepts names beginning with a dash as literal names`, async () => {
        const menu = await open_menu( { name: `--wip` } )
        menu.input.write( `\r` )
        expect( await menu.result ).toMatchObject( { flags: { name: `--wip` }, passthrough: [] } )
    } )

    it( `restores the screen if enabling raw input fails`, async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        let rendered = ``
        input.isTTY = true
        output.isTTY = true
        output.on( `data`, chunk => rendered += chunk.toString() )
        input.setRawMode = () => {
            throw new Error( `terminal disconnected` )
        }
        await expect( launch_menu( { ...options, input, output } ) ).rejects.toThrow( `terminal disconnected` )
        expect( rendered ).toContain( `\x1b[?25h\x1b[?1049l` )
    } )

    it( `rejects redirected input or output before changing the terminal`, async () => {

        for( const redirected of [ `input`, `output` ] ) {
            const input = new PassThrough()
            const output = new PassThrough()
            let raw_changed = false
            input.isTTY = redirected !== `input`
            output.isTTY = redirected !== `output`
            input.setRawMode = () => raw_changed = true

            await expect( launch_menu( { ...options, input, output } ) ).rejects.toThrow( /interactive terminal/ )
            expect( raw_changed ).toBe( false )
            expect( output.readableLength ).toBe( 0 )
        }

    } )

    it( `restores terminal state on EOF or input failure`, async () => {

        const ended = await open_menu()
        ended.input.end()
        expect( await ended.result ).toBeNull()
        expect( ended.raw_modes ).toEqual( [ true, false ] )
        expect( ended.rendered() ).toEndWith( `\x1b[?25h\x1b[?1049l` )
        expect( ended.output.listenerCount( `resize` ) ).toBe( 0 )

        const failed = await open_menu()
        failed.input.emit( `error`, new Error( `terminal disconnected` ) )
        await expect( failed.result ).rejects.toThrow( `terminal disconnected` )
        expect( failed.raw_modes ).toEqual( [ true, false ] )
        expect( failed.input.isPaused() ).toBe( true )
        expect( failed.rendered() ).toEndWith( `\x1b[?25h\x1b[?1049l` )

    } )

    it( `preserves a caller's existing raw and flowing input state`, async () => {

        const menu = await open_menu( {}, { raw: true, flowing: true } )
        menu.input.write( `\x03` )
        expect( await menu.result ).toBeNull()
        expect( menu.raw_modes ).toEqual( [ true, true ] )
        expect( menu.input.readableFlowing ).toBe( true )
        menu.input.pause()

    } )

    it( `edits the second-line name and toggles all flags using terminal keys`, async () => {

        await save_launch_defaults( parse_args( [ `claude` ] ), options )
        const menu = await open_menu( { name: `draft` } )

        menu.input.write( `${ right }${ down }\x7f\x7f\x7f\x7f\x7ffix login${ down } ${ down } ${ down } ${ down } \r` )
        expect( await menu.result ).toMatchObject( {
            verb: `start`, agent: `codex`, passthrough: [],
            flags: { name: `fix login`, docker: true, yolo: true, clone: true, loop: true, sandbox: false, mudbox: false },
        } )
        expect( menu.raw_modes ).toEqual( [ true, false ] )
        expect( menu.input.isPaused() ).toBe( true )
        expect( menu.input.listenerCount( `keypress` ) ).toBe( 0 )

    } )

    it( `starts with remembered agent and flags, and accepts Enter from the model row`, async () => {

        await save_launch_defaults( parse_args( [ `opencode`, `--yolo`, `--loop`, `--mudbox` ] ), options )
        const menu = await open_menu()
        menu.input.write( `\r` )

        expect( await menu.result ).toMatchObject( {
            agent: `opencode`, flags: { name: false, yolo: true, loop: true, mudbox: true, sandbox: false },
        } )

    } )

    it( `cycles models in both directions and keeps clone compatible with modes`, async () => {

        await save_launch_defaults( parse_args( [ `claude`, `--clone` ] ), options )
        const menu = await open_menu()
        menu.input.write( `${ left }${ right }${ down.repeat( 6 ) }${ right }\r` )

        expect( await menu.result ).toMatchObject( {
            agent: `claude`, flags: { clone: false, sandbox: true, mudbox: false },
        } )

        const second = await open_menu()
        second.input.write( `${ down.repeat( 6 ) }${ left }${ up.repeat( 2 ) } \r` )
        expect( await second.result ).toMatchObject( {
            flags: { clone: true, sandbox: false, mudbox: false },
        } )

    } )

    it( `cancels with Escape or Ctrl+C without changing preferences`, async () => {

        await save_launch_defaults( parse_args( [ `claude` ] ), options )
        const before = readFileSync( options.defaults_path, `utf8` )

        for( const cancel of [ `\x1b`, `\x03` ] ) {
            const menu = await open_menu()
            menu.input.write( `${ right }${ cancel }` )
            expect( await menu.result ).toBeNull()
            expect( menu.raw_modes ).toEqual( [ true, false ] )
            expect( menu.input.isPaused() ).toBe( true )
        }

        expect( readFileSync( options.defaults_path, `utf8` ) ).toBe( before )

    } )

    it( `validates a name before launching and allows correcting it`, async () => {

        const menu = await open_menu( { name: `123` } )
        menu.input.write( `\r` )
        await new Promise( resolve => setImmediate( resolve ) )
        expect( menu.input.isRaw ).toBe( true )
        expect( menu.rendered() ).toMatch( /reserved|numbers|name/i )

        menu.input.write( `${ down }\x7f\x7f\x7frelease\r` )
        expect( await menu.result ).toMatchObject( { flags: { name: `release` } } )

    } )

} )
