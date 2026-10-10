import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { show_help } from '../src/cli/help.js'
import { HELP_TOPIC_NAMES, help_topic, wants_help } from '../src/cli/help_topics.js'

describe( `CLI help`, () => {

    let lines
    let original_log

    beforeEach( () => {
        lines = []
        original_log = console.log
        console.log = ( line = `` ) => lines.push( String( line ) )
    } )

    afterEach( () => {
        console.log = original_log
    } )

    it( `documents doctor selection, real auth checks, and cache refresh`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit doctor --auth [agent|all]` )
        expect( help ).toContain( `make real model-backed auth checks` )
        expect( help ).toContain( `bypass the 12-hour success cache` )
        expect( help ).toContain( `babysit doctor --auth opencode --refresh` )

    } )

    it( `documents the auth cache commands and the scheduled checker`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit auth [status]` )
        expect( help ).toContain( `babysit auth check` )
        expect( help ).toContain( `babysit auth init [--remove]` )
        expect( help ).toContain( `uninstall the scheduled checker` )

    } )

    it( `documents workspace-aware resume history and its --all escape hatch`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `List this workspace's sessions or resume one` )
        expect( help ).toContain( `with "resume [number]", use every workspace` )
        expect( help ).toContain( `babysit resume --all` )

    } )

    it( `documents Docker and clone pruning plus the noninteractive inventory`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit prune [--list]` )
        expect( help ).toContain( `Prune unused Docker data and clone workspaces` )
        expect( help ).toContain( `list clone workspaces and directory sizes` )

    } )

    it( `documents web bridge initialization`, () => {

        show_help()

        const help = lines.join( `\n` )
        expect( help ).toContain( `babysit web init` )
        expect( help ).toContain( `Initialize or rotate babysit-web access` )

    } )

    describe( `per-command help`, () => {

        it( `routes subcommands, agents, and help words to their own page`, () => {
            expect( help_topic( [ `auth`, `--help` ] ) ).toStartWith( `Usage: babysit auth [status]` )
            expect( help_topic( [ `auth`, `init`, `--help` ] ) ).toStartWith( `Usage: babysit auth init` )
            expect( help_topic( [ `help`, `auth`, `check` ] ) ).toStartWith( `Usage: babysit auth check` )
            expect( help_topic( [ `recover`, `init`, `-h` ] ) ).toStartWith( `Usage: babysit recover init` )
            expect( help_topic( [ `codex`, `--name`, `x`, `--help` ] ) ).toStartWith( `Usage: babysit codex [options]` )
            expect( help_topic( [ `claude`, `resume`, `2`, `--help` ] ) ).toStartWith( `Usage: babysit claude resume` )
            expect( help_topic( [ `auth`, `bogus`, `--help` ] ) ).toStartWith( `Usage: babysit auth [status]` )
            expect( help_topic( [ `--help` ] ) ).toBe( null )
            expect( help_topic( [ `nonsense`, `--help` ] ) ).toBe( null )
        } )

        it( `gives every page a usage line and examples`, () => {
            const pages = [ ...HELP_TOPIC_NAMES.filter( name => !name.startsWith( `agent` ) ), `claude`, `claude resume` ]
            for( const name of pages ) {
                const page = help_topic( [ ...name.split( ` ` ), `--help` ] )
                expect( page ).toStartWith( `Usage: babysit ${ name }` )
                expect( page ).toMatch( /\nExamples?:\n {2}babysit / )
            }
        } )

        it( `asks for help on --help, -h, or a leading help word only`, () => {
            expect( wants_help( [ `auth`, `-h` ] ) ).toBe( true )
            expect( wants_help( [ `help` ] ) ).toBe( true )
            expect( wants_help( [ `feature help` ] ) ).toBe( false )
            expect( wants_help( [ `claude`, `--yolo` ] ) ).toBe( false )
        } )

        it( `prints the page instead of the overview`, () => {
            show_help( [ `auth`, `init`, `--help` ] )
            expect( lines.join( `\n` ) ).toContain( `--claude-token` )
            lines.length = 0
            show_help()
            expect( lines.join( `\n` ) ).toContain( `babysit auth init --help` )
        } )

    } )

} )
