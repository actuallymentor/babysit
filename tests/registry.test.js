import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

import { show_help } from '../src/cli/help.js'
import { HELP_TOPIC_NAMES } from '../src/cli/help_topics.js'
import { COMMANDS, FLAGS, LAUNCH_FLAG_ROWS, OVERVIEW_FLAG_ROWS, flag_named, option_tokens } from '../src/cli/registry.js'

const README = readFileSync( join( import.meta.dir, `../README.md` ), `utf8` )

// `| \`--port PORT\` | Publish ... |` rows of the README's flag table, backticks dropped
const readme_rows = () => {
    const table = README.slice( README.indexOf( `| Flag | Effect |` ) ).split( `\n\n` )[0]
    return table.split( `\n` ).slice( 2 ).map( line => line.split( ` | ` ).map( cell => cell.replace( /^\| |\s*\|$/g, `` ).replaceAll( `\``, `` ) ) )
}

// `--no-linger` and `-n` resolve to their registry flag
const registered = token => {
    const name = token.replace( /^--?/, `` )
    return Boolean( flag_named( name ) || name.startsWith( `no-` ) && flag_named( name.slice( 3 ) )?.type === `boolean` )
}

describe( `flag registry`, () => {

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

    it( `README flag table lists every launch flag with its registry description`, () => {
        const rows = readme_rows()
        for( const row of LAUNCH_FLAG_ROWS ) expect( rows ).toContainEqual( row )

        // Extra README rows (no flag, --config DIR/) still name registered flags only
        const tokens = rows.flatMap( ( [ usage ] ) => usage.match( /--?[a-z][\w-]*/g ) || [] )
        expect( tokens.filter( token => !registered( token ) ) ).toEqual( [] )
    } )

    it( `babysit --help flag rows are the registry rows`, () => {
        show_help()
        const help = lines.join( `\n` )
        const section = help.slice( help.indexOf( `\nFlags:\n` ) + 8 ).split( `\n\n` )[0]

        // Over-wide usages put their text on the next, indented line
        const rows = []
        for( const line of section.split( `\n` ) ) {
            if( /^ {18}\S/.test( line ) ) rows.at( -1 )[1] = line.trim()
            else rows.push( line.trim().split( / {2,}/ ) )
        }
        expect( rows ).toEqual( OVERVIEW_FLAG_ROWS )
    } )

    it( `lists in-session commands under their own heading`, () => {
        show_help()
        const help = lines.join( `\n` )
        const host = help.slice( 0, help.indexOf( `In a session` ) )
        const session = help.slice( help.indexOf( `In a session` ) ).split( `\n\n` )[0]

        for( const command of COMMANDS.filter( entry => entry.context === `container` ) ) {
            expect( session ).toContain( `babysit ${ command.name }` )
            expect( host ).not.toContain( `  babysit ${ command.name } ` )
        }
    } )

    it( `command options only name registered flags`, () => {
        const tokens = COMMANDS.flatMap( command => [
            ...option_tokens( command.name ),
            ...Object.keys( command.subcommands || {} ).flatMap( sub => option_tokens( command.name, sub ) ),
        ] )
        expect( tokens.length ).toBeGreaterThan( 10 )
        expect( tokens.filter( token => !registered( token ) ) ).toEqual( [] )
    } )

    it( `every visible command word has a help page`, () => {
        const parsed_only = [ `launch`, `start`, `launch_dir` ]
        const words = COMMANDS.filter( command => !command.hidden && !parsed_only.includes( command.name ) ).map( command => command.name )
        expect( words.filter( word => !HELP_TOPIC_NAMES.includes( word ) ) ).toEqual( [] )
    } )

    it( `flags are unique and well-formed`, () => {
        const names = FLAGS.map( flag => flag.name )
        expect( new Set( names ).size ).toBe( names.length )
        for( const flag of FLAGS ) {
            expect( [ `boolean`, `value`, `optional` ] ).toContain( flag.type )
            expect( [ `global`, `launch`, `command`, `local`, `container` ] ).toContain( flag.scope )
            if( [ `command`, `local`, `container` ].includes( flag.scope ) ) expect( flag.commands?.length ).toBeGreaterThan( 0 )
        }
    } )

} )
