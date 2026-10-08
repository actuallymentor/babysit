import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse } from 'yaml'
import { load_config, get_default_yaml, write_default_config } from '../src/babysit/yaml.js'
import { base } from '../src/system_prompt/index.js'

describe( `babysit.yaml`, () => {

    let tmpdir_path

    beforeEach( () => {
        tmpdir_path = mkdtempSync( join( tmpdir(), `babysit-test-` ) )
    } )

    afterEach( () => {
        rmSync( tmpdir_path, { recursive: true, force: true } )
    } )

    it( `uses defaults without writing a file when babysit.yaml is missing`, () => {
        const { config, rules } = load_config( tmpdir_path )
        expect( existsSync( join( tmpdir_path, `babysit.yaml` ) ) ).toBe( false )
        expect( config.idle_timeout_s ).toBe( 300 )
        expect( rules ).toEqual( [] )
    } )

    it( `babysit init writes the default yaml once`, () => {
        const path = write_default_config( tmpdir_path, { initial_prompt: `custom default prompt` } )
        expect( readFileSync( path, `utf8` ) ).toContain( `custom default prompt` )
        expect( () => write_default_config( tmpdir_path ) ).toThrow( /already exists/ )
        // All comments: loading the written file still yields the defaults
        expect( load_config( tmpdir_path ).config.idle_timeout_s ).toBe( 300 )
    } )

    it( `parses default config values`, () => {
        const { config } = load_config( tmpdir_path )
        expect( config.idle_timeout_s ).toBe( 300 )
        expect( config.initial_prompt ).toBe( base )
        expect( config.isolate_dependencies ).toBe( true )
    } )

    it( `uses the supplied default prompt when no yaml exists`, () => {
        const { config } = load_config( tmpdir_path, { default_initial_prompt: `custom default prompt` } )
        expect( config.initial_prompt ).toBe( `custom default prompt` )
    } )

    it( `keeps default supervision examples disabled`, () => {
        const { rules } = load_config( tmpdir_path )
        expect( rules ).toEqual( [] )
    } )

    it( `resolves relative markdown actions beside a --config file`, () => {
        const config_dir = join( tmpdir_path, `babysit` )
        mkdirSync( config_dir )
        writeFileSync( join( config_dir, `LOOP_ERRORS.md` ), `Fix errors` )
        const config_path = join( config_dir, `errors.yaml` )
        writeFileSync( config_path, `
babysit:
    - on: idle
      do: ./LOOP_ERRORS.md
    - on: idle
      do: ./MISSING.md
` )
        const { rules } = load_config( tmpdir_path, { config_path } )
        expect( rules[0].do ).toBe( join( config_dir, `LOOP_ERRORS.md` ) )
        // Not beside the config: left for cwd resolution at execution time
        expect( rules[1].do ).toBe( `./MISSING.md` )
    } )

    it( `leaves a named command alone even when a same-named file exists`, () => {
        writeFileSync( join( tmpdir_path, `notify.md` ), `not a command` )
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config:
    commands:
        notify.md: echo hi
babysit:
    - on: idle
      do: notify.md
` )
        const { rules } = load_config( tmpdir_path )
        expect( rules[0].do ).toBe( `notify.md` )
    } )

    it( `anchors in-tree config markdown to the clone workspace`, () => {
        const source = join( tmpdir_path, `source` )
        const clone = join( tmpdir_path, `clone` )
        mkdirSync( join( source, `babysit` ), { recursive: true } )
        mkdirSync( join( clone, `babysit` ), { recursive: true } )
        writeFileSync( join( source, `babysit`, `LOOP.md` ), `source copy` )
        writeFileSync( join( clone, `babysit`, `LOOP.md` ), `clone copy` )
        const config_path = join( source, `babysit`, `errors.yaml` )
        writeFileSync( config_path, `
babysit:
    - on: idle
      do: ./LOOP.md
` )
        const { rules } = load_config( clone, { config_path, source_dir: source } )
        expect( rules[0].do ).toBe( join( clone, `babysit`, `LOOP.md` ) )
    } )

    it( `parses custom config`, () => {
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config:
    idle_timeout_s: 60
    isolate_dependencies: false
babysit:
    - on: idle
      do: "keep going"
` )
        const { config, rules } = load_config( tmpdir_path )
        expect( config.idle_timeout_s ).toBe( 60 )
        expect( config.isolate_dependencies ).toBe( false )
        expect( rules.length ).toBe( 1 )
    } )

    it( `uses the generated launch prompt when an existing config omits initial_prompt`, () => {
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config:
    idle_timeout_s: 60
babysit:
    - on: idle
      do: "keep going"
` )
        const { config } = load_config( tmpdir_path, { default_initial_prompt: `generated launch prompt` } )
        expect( config.initial_prompt ).toBe( `generated launch prompt` )
    } )

    it( `keeps explicit null initial_prompt as startup typing opt-out`, () => {
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config:
    initial_prompt: null
    idle_timeout_s: 60
babysit:
    - on: idle
      do: "keep going"
` )
        const { config } = load_config( tmpdir_path, { default_initial_prompt: `generated launch prompt` } )
        expect( config.initial_prompt ).toBe( null )
    } )

    it( `treats a non-array babysit section as no rules`, () => {
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config: {}
babysit:
    on: idle
    do: "keep going"
` )
        const { rules } = load_config( tmpdir_path )
        expect( rules ).toEqual( [] )
    } )

    it( `parses literal string on: values`, () => {
        writeFileSync( join( tmpdir_path, `babysit.yaml` ), `
config: {}
babysit:
    - on: "test string"
      do: "echo hello"
` )
        const { rules } = load_config( tmpdir_path )
        expect( rules[0].on.type ).toBe( `literal` )
        expect( rules[0].on.value ).toBe( `test string` )
    } )

    it( `returns a default yaml that is all comments and documents every setting`, () => {
        const yaml = get_default_yaml()
        expect( yaml.split( `\n` ).every( line => !line.trim() || line.startsWith( `#` ) ) ).toBe( true )
        expect( parse( yaml ) ).toBeNull()
        for( const key of [ `initial_prompt`, `idle_timeout_s`, `yolo_approve_dangerous_commands`, `isolate_dependencies`, `clone:`, `commands:`, `on: idle`, `===`, `--loop` ] ) {
            expect( yaml ).toContain( key )
        }
        expect( yaml ).toContain( base.split( `\n` )[0] )
    } )

    it( `returns default yaml with a caller-supplied prompt`, () => {
        const yaml = get_default_yaml( { initial_prompt: `custom default prompt` } )
        expect( yaml ).toContain( `custom default prompt` )
    } )

} )
