import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { get_default_yaml, load_clone_config, load_config, merge_layers, write_global_config } from '../src/babysit/yaml.js'
import { cmd_init } from '../src/cli/init.js'

const directories = []
const temporary = () => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-global-config-` ) )
    directories.push( directory )
    return directory
}

afterEach( () => directories.splice( 0 ).forEach( directory => rmSync( directory, { recursive: true, force: true } ) ) )

// A home with ~/.babysitrc.yaml and a workspace with babysit.yaml
const layers = ( global_yaml, local_yaml = null ) => {
    const home = temporary()
    const workspace = temporary()
    const global_path = join( home, `.babysitrc.yaml` )
    writeFileSync( global_path, global_yaml )
    if( local_yaml !== null ) writeFileSync( join( workspace, `babysit.yaml` ), local_yaml )
    return { home, workspace, global_path }
}

describe( `merge_layers`, () => {

    it( `merges mappings key by key and lets lists and scalars replace`, () => {
        expect( merge_layers(
            { a: 1, nested: { keep: true, swap: 1 }, list: [ 1, 2 ] },
            { nested: { swap: 2 }, list: [ 3 ], extra: null },
        ) ).toEqual( { a: 1, nested: { keep: true, swap: 2 }, list: [ 3 ], extra: null } )
        expect( merge_layers( { a: 1 }, undefined ) ).toEqual( { a: 1 } )
    } )

} )

describe( `global ~/.babysitrc.yaml layer`, () => {

    it( `sits between the defaults and the workspace file`, () => {
        const { workspace, global_path } = layers(
            `config:\n  idle_timeout_s: 120\n  watchdog_idle_s: 60\n  commands:\n    ping: echo global\nprompts:\n  loop: Global loop\n  recovery: Global recovery\n`,
            `config:\n  idle_timeout_s: 30\n  commands:\n    pong: echo local\nprompts:\n  loop: Local loop\n`,
        )

        const { config } = load_config( workspace, { global_path } )

        // Workspace wins, global fills in, defaults remain underneath
        expect( config.idle_timeout_s ).toBe( 30 )
        expect( config.watchdog_idle_s ).toBe( 60 )
        expect( config.watchdog_waiting_s ).toBe( 900 )
        expect( config.commands ).toEqual( { ping: `echo global`, pong: `echo local` } )
        expect( config.prompts.loop ).toBe( `Local loop` )
        expect( config.prompts.recovery ).toBe( `Global recovery` )
    } )

    it( `applies alone when the workspace has no babysit.yaml`, () => {
        const { workspace, global_path, home } = layers( `config:\n  initial_prompt: null\nbabysit:\n  - on: idle\n    do: ./IDLE.md\n` )
        writeFileSync( join( home, `IDLE.md` ), `Keep at it` )

        const { config, rules } = load_config( workspace, { global_path, default_initial_prompt: `generated` } )

        // An explicit global opt-out survives; global markdown resolves beside the global file
        expect( config.initial_prompt ).toBeNull()
        expect( rules ).toHaveLength( 1 )
        expect( rules[ 0 ].do ).toBe( join( home, `IDLE.md` ) )
    } )

    it( `lets a workspace babysit: list replace the global rules, even an empty one`, () => {
        const global = `babysit:\n  - on: idle\n    do: global\n`
        const replaced = layers( global, `babysit:\n  - on: /error/\n    do: local\n` )
        const emptied = layers( global, `babysit: []\n` )
        const inherited = layers( global, `config:\n  idle_timeout_s: 10\n` )

        expect( load_config( replaced.workspace, { global_path: replaced.global_path } ).rules.map( rule => rule.do ) ).toEqual( [ `local` ] )
        expect( load_config( emptied.workspace, { global_path: emptied.global_path } ).rules ).toEqual( [] )
        expect( load_config( inherited.workspace, { global_path: inherited.global_path } ).rules.map( rule => rule.do ) ).toEqual( [ `global` ] )
    } )

    it( `skips broken global rules, but a broken workspace rule still fails`, () => {
        const broken = `babysit:\n  - on: /[/i\n    do: nudge\n`
        const inherited = layers( broken, `config:\n  idle_timeout_s: 30\n` )
        expect( load_config( inherited.workspace, { global_path: inherited.global_path } ).rules ).toEqual( [] )

        const local = layers( `config: {}\n`, broken )
        expect( () => load_config( local.workspace, { global_path: local.global_path } ) ).toThrow()
    } )

    it( `skips a broken global file instead of failing every launch`, () => {
        const { workspace, global_path } = layers( `config: [unclosed\n`, `config:\n  idle_timeout_s: 30\n` )
        expect( load_config( workspace, { global_path } ).config.idle_timeout_s ).toBe( 30 )
    } )

    it( `layers config.clone too`, () => {
        const { workspace, global_path } = layers( `config:\n  clone:\n    mode: copy\n    depth: 5\n`, `config:\n  clone:\n    depth: 2\n` )
        expect( load_clone_config( workspace, { global_path } ) ).toMatchObject( { mode: `copy`, depth: 2 } )
    } )

} )

describe( `babysit init --global`, () => {

    const run = async ( { exists = false, answer = true } = {} ) => {
        const home = temporary()
        const path = join( home, `.babysitrc.yaml` )
        if( exists ) writeFileSync( path, `config:\n  idle_timeout_s: 1\n` )
        const printed = []
        const asked = []
        await cmd_init( { flags: { global: true } }, {
            print: message => printed.push( message ),
            global: { path, confirm: async question => ( asked.push( question ), answer ) },
        } )
        return { path, printed, asked }
    }

    it( `writes the commented global file without a launch section or asking`, async () => {
        const { path, asked } = await run()
        const yaml = readFileSync( path, `utf-8` )

        expect( asked ).toEqual( [] )
        expect( yaml ).toStartWith( `# ~/.babysitrc.yaml` )
        expect( yaml ).not.toMatch( /^launch:/m )
        expect( yaml ).toContain( `# prompts:` )
        // Every line is a comment or blank: defaults apply until uncommented
        expect( yaml.split( `\n` ).filter( line => line.trim() && !line.startsWith( `#` ) ) ).toEqual( [] )
    } )

    it( `overwrites an existing file only on yes`, async () => {
        const kept = await run( { exists: true, answer: false } )
        expect( kept.asked ).toHaveLength( 1 )
        expect( readFileSync( kept.path, `utf-8` ) ).toBe( `config:\n  idle_timeout_s: 1\n` )
        expect( kept.printed.join( `\n` ) ).toContain( `nothing written` )

        const replaced = await run( { exists: true, answer: true } )
        expect( readFileSync( replaced.path, `utf-8` ) ).toStartWith( `# ~/.babysitrc.yaml` )
    } )

    it( `refuses a file name alongside --global`, async () => {
        await expect( cmd_init( { flags: { global: true }, session_id: `x.yaml` } ) ).rejects.toThrow( `--global` )
    } )

    it( `keeps the workspace template's launch section and layer note`, () => {
        const yaml = get_default_yaml()
        expect( yaml ).toMatch( /^launch:/m )
        expect( yaml ).toContain( `defaults < ~/.babysitrc.yaml < this file < command line flags` )
        expect( existsSync( write_global_config( { path: join( temporary(), `g.yaml` ) } ) ) ).toBe( true )
    } )

} )
