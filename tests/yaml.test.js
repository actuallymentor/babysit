import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { load_config, get_default_yaml } from '../src/babysit/yaml.js'

describe( `babysit.yaml`, () => {

    let tmpdir_path

    beforeEach( () => {
        tmpdir_path = mkdtempSync( join( tmpdir(), `babysit-test-` ) )
    } )

    afterEach( () => {
        rmSync( tmpdir_path, { recursive: true, force: true } )
    } )

    it( `creates default yaml when missing`, () => {
        load_config( tmpdir_path )
        expect( existsSync( join( tmpdir_path, `babysit.yaml` ) ) ).toBe( true )
    } )

    it( `parses default config values`, () => {
        const { config } = load_config( tmpdir_path )
        expect( config.idle_timeout_s ).toBe( 300 )
        expect( config.initial_prompt ).toContain( `running inside a Docker container` )
        expect( config.isolate_dependencies ).toBe( true )
        expect( config.lines_for_literal_match ).toBe( 10 )
    } )

    it( `writes the supplied default prompt into a newly-created yaml`, () => {
        const { config } = load_config( tmpdir_path, { default_initial_prompt: `custom default prompt` } )
        expect( config.initial_prompt ).toBe( `custom default prompt` )
    } )

    it( `parses rules from default yaml`, () => {
        const { rules } = load_config( tmpdir_path )
        expect( rules.length ).toBeGreaterThanOrEqual( 3 )
        expect( rules[0].on.type ).toBe( `idle` )
    } )

    it( `parses idle rule with timeout override`, () => {
        const { rules } = load_config( tmpdir_path )
        const idle_rule = rules.find( r => r.on.type === `idle` )
        expect( idle_rule ).toBeDefined()
        expect( idle_rule.timeout_s ).toBe( 1800 ) // 30:00
    } )

    it( `parses choice rule`, () => {
        const { rules } = load_config( tmpdir_path )
        const choice_rule = rules.find( r => r.on.type === `choice` )
        expect( choice_rule ).toBeDefined()
    } )

    it( `parses regex rule`, () => {
        const { rules } = load_config( tmpdir_path )
        const regex_rule = rules.find( r => r.on.type === `regex` )
        expect( regex_rule ).toBeDefined()
        expect( regex_rule.on.value ).toBeInstanceOf( RegExp )
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

    it( `returns default yaml string`, () => {
        const yaml = get_default_yaml()
        expect( yaml ).toContain( `idle_timeout_s` )
        expect( yaml ).toContain( `initial_prompt` )
        expect( yaml ).toContain( `running inside a Docker container` )
        expect( yaml ).toContain( `babysit:` )
    } )

    it( `returns default yaml with a caller-supplied prompt`, () => {
        const yaml = get_default_yaml( { initial_prompt: `custom default prompt` } )
        expect( yaml ).toContain( `custom default prompt` )
    } )

} )
