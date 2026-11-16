import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_PROMPTS, resolve_prompts } from '../src/babysit/prompts.js'
import { load_config, get_default_yaml } from '../src/babysit/yaml.js'
import { create_watchdog } from '../src/babysit/watchdog.js'
import { apply_loop } from '../src/modes/loop.js'
import { create_loop_controller } from '../src/control/loop.js'

describe( `prompts`, () => {

    let dir

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-prompts-` ) )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `has a default for every key`, () => {
        expect( Object.keys( DEFAULT_PROMPTS ).sort() ).toEqual( [ `account_switch`, `check_in`, `loop`, `recovery`, `watchdog` ] )
        for( const text of Object.values( DEFAULT_PROMPTS ) ) expect( text.trim() ).not.toBe( `` )
    } )

    it( `resolve_prompts returns defaults without input`, () => {
        expect( resolve_prompts() ).toEqual( DEFAULT_PROMPTS )
        expect( resolve_prompts( null ) ).toEqual( DEFAULT_PROMPTS )
    } )

    it( `resolve_prompts merges overrides and ignores blank, non-string and unknown values`, () => {
        const prompts = resolve_prompts( { loop: `Go on`, recovery: `   `, watchdog: 5, nonsense: `x` } )
        expect( prompts ).toEqual( { ...DEFAULT_PROMPTS, loop: `Go on` } )
    } )

    it( `resolve_prompts falls back to defaults for a non-mapping`, () => {
        expect( resolve_prompts( `text` ) ).toEqual( DEFAULT_PROMPTS )
        expect( resolve_prompts( [ `a` ] ) ).toEqual( DEFAULT_PROMPTS )
    } )

    it( `load_config reads prompts and defaults the rest`, () => {
        writeFileSync( join( dir, `babysit.yaml` ), `prompts:\n    check_in: Look at your jobs\n` )
        const { config } = load_config( dir )
        expect( config.prompts.check_in ).toBe( `Look at your jobs` )
        expect( config.prompts.loop ).toBe( DEFAULT_PROMPTS.loop )
    } )

    it( `load_config without a prompts section yields the defaults`, () => {
        expect( load_config( dir ).config.prompts ).toEqual( DEFAULT_PROMPTS )
    } )

    it( `default yaml documents the keys and links the defaults, without the texts`, () => {
        const yaml = get_default_yaml()
        expect( yaml ).toContain( `# prompts:` )
        expect( yaml ).toContain( `https://github.com/actuallymentor/babysit/blob/main/src/babysit/prompts.js` )
        for( const key of Object.keys( DEFAULT_PROMPTS ) ) expect( yaml ).toContain( `#     ${ key }:` )
        for( const text of Object.values( DEFAULT_PROMPTS ) ) expect( yaml ).not.toContain( text )
    } )

    it( `watchdog types the configured texts per nudge kind`, async () => {
        let time = 0
        const prompts = { ...DEFAULT_PROMPTS, watchdog: `W`, check_in: `C` }
        const make = () => create_watchdog( {
            session_name: `s`, idle_s: 10, waiting_s: 10, prompts, now: () => time,
            judge: async () => ( { nudge: true, reason: `r`, judge: `test` } ),
            typed_at: () => null,
        } )
        const settle = () => new Promise( done => setTimeout( done, 0 ) )

        for( const [ status, expected ] of [ [ `idle`, `W` ], [ `waiting`, `C` ] ] ) {
            time = 0
            const watchdog = make()
            watchdog.observe( status )
            time = 11_000
            watchdog.observe( status )
            await settle()
            expect( await watchdog.take( status ) ).toBe( expected )
        }
    } )

    it( `apply_loop uses loop_text when no LOOP.md exists`, () => {
        const rules = []
        apply_loop( rules, dir, { include_global_loop: false, loop_text: `Onward` } )
        expect( rules[ 0 ].do ).toEqual( { text: `Onward` } )
    } )

    it( `loop controller reads loop_text fresh on each toggle`, async () => {
        let text = `one`
        const seen = []
        const session = { babysit_id: `b`, tmux_session: `t`, modifiers: [] }
        const controller = create_loop_controller( session, {
            rules: [], workspace: dir, load_rules: () => [], update: () => {}, set_label: async () => {},
            apply: ( rules, workspace, options ) => seen.push( options.loop_text ),
            loop_text: () => text,
        } )
        await controller.toggle()
        text = `two`
        await controller.toggle() // off: no apply
        await controller.toggle()
        expect( seen ).toEqual( [ `one`, `two` ] )
    } )

} )
