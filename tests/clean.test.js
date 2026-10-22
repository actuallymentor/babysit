import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { clean_yaml, cmd_clean } from '../src/cli/clean.js'
import { parse_args } from '../src/cli/parse.js'

let root

beforeEach( () => {
    root = mkdtempSync( join( tmpdir(), `babysit-clean-` ) )
} )

afterEach( () => rmSync( root, { recursive: true, force: true } ) )

const SAMPLE = `# Team config

# How the session starts
launch:
    agent: claude # the main one

    # regular | sandbox | mudbox
    mode: regular
    ports: [ 3000 ]   # dev server

# keep these rules
babysit:
    - on: idle
      do: "Keep going"
`

describe( `clean_yaml`, () => {

    it( `drops full-line comments and blank lines, keeps inline comments`, () => {
        const { text, comments, blanks } = clean_yaml( SAMPLE )
        expect( text ).toBe( `launch:
    agent: claude # the main one
    mode: regular
    ports: [ 3000 ]   # dev server
babysit:
    - on: idle
      do: "Keep going"
` )
        expect( comments ).toBe( 4 )
        expect( blanks ).toBe( 3 )
        expect( parse( text ) ).toEqual( parse( SAMPLE ) )
    } )

    it( `never touches lines inside block and multi-line scalars`, () => {
        const source = `launch:
    agent: claude
# gone
babysit:
    - on: idle
      do: |
        # not a comment, it is the prompt

        second paragraph # nor this

        last
    - on: idle
      do: "quoted

        across lines"
`
        const { text, comments, blanks } = clean_yaml( source )
        expect( parse( text ) ).toEqual( parse( source ) )
        expect( text ).toContain( `        # not a comment, it is the prompt\n\n        second paragraph # nor this\n\n        last` )
        expect( text ).not.toContain( `# gone` )
        expect( comments ).toBe( 1 )
        expect( blanks ).toBe( 0 )
    } )

    it( `is idempotent and keeps CRLF line endings`, () => {
        const once = clean_yaml( SAMPLE.replaceAll( `\n`, `\r\n` ) ).text
        expect( once ).toContain( `\r\n` )
        expect( once.replaceAll( `\r\n`, `` ) ).not.toContain( `\n` )
        expect( clean_yaml( once ).text ).toBe( once )
    } )

    it( `turns a comment-only file into an empty one and rejects invalid yaml`, () => {
        expect( clean_yaml( `# just a note\n\n` ).text ).toBe( `` )
        expect( () => clean_yaml( `launch: [unclosed\n` ) ).toThrow()
    } )

} )

describe( `babysit clean`, () => {

    const run = async config => {
        const lines = []
        const code = await cmd_clean( parse_args( [ `clean`, `--config`, config ] ), { print: line => lines.push( line ) } )
        return { code, lines }
    }

    it( `parses as the clean verb with --config and --dry-run`, () => {
        expect( parse_args( [ `clean`, `--config`, `a.yaml` ] ) ).toMatchObject( { verb: `clean`, flags: { dry_run: false } } )
        expect( parse_args( [ `clean`, `--config`, `a`, `--dry-run` ] ).flags.dry_run ).toBe( true )
    } )

    it( `cleans one file in place and reports it`, async () => {
        const file = join( root, `config.yaml` )
        writeFileSync( file, SAMPLE )

        const { code, lines } = await run( file )
        expect( code ).toBe( 0 )
        expect( lines ).toEqual( [ `config.yaml: removed 4 comment lines, 3 blank lines` ] )
        expect( readFileSync( file, `utf8` ) ).not.toContain( `# Team config` )
        expect( readFileSync( file, `utf8` ) ).toContain( `# the main one` )
        expect( readdirSync( root ) ).toEqual( [ `config.yaml` ] )

        expect( ( await run( file ) ).lines ).toEqual( [ `config.yaml: already clean` ] )
    } )

    it( `cleans every yaml in a directory, skipping other files and failing on bad yaml`, async () => {
        const dir = join( root, `sessions` )
        mkdirSync( dir )
        writeFileSync( join( dir, `a.yaml` ), SAMPLE )
        writeFileSync( join( dir, `b.yml` ), `# note\nlaunch:\n    agent: codex\n` )
        writeFileSync( join( dir, `broken.yaml` ), `launch: [unclosed\n` )
        writeFileSync( join( dir, `notes.md` ), `# keep\n\n` )

        const { code, lines } = await run( dir )
        expect( code ).toBe( 1 )
        expect( lines.some( line => line.startsWith( `a.yaml: removed` ) ) ).toBe( true )
        expect( lines.some( line => line.startsWith( `b.yml: removed 1 comment line, 0 blank lines` ) ) ).toBe( true )
        expect( lines.some( line => line.includes( `broken.yaml` ) ) ).toBe( true )
        expect( readFileSync( join( dir, `notes.md` ), `utf8` ) ).toBe( `# keep\n\n` )
        expect( readFileSync( join( dir, `broken.yaml` ), `utf8` ) ).toBe( `launch: [unclosed\n` )
    } )

    it( `--dry-run writes nothing`, async () => {
        const file = join( root, `config.yaml` )
        writeFileSync( file, SAMPLE )
        const lines = []
        await cmd_clean( parse_args( [ `clean`, `--config`, file, `--dry-run` ] ), { print: line => lines.push( line ) } )
        expect( lines[0] ).toContain( `would remove 4 comment lines` )
        expect( readFileSync( file, `utf8` ) ).toBe( SAMPLE )
    } )

    it( `needs --config and an existing path`, async () => {
        await expect( cmd_clean( parse_args( [ `clean` ] ) ) ).rejects.toThrow( /needs --config/ )
        await expect( run( join( root, `missing.yaml` ) ) ).rejects.toThrow( /No such file or directory/ )
    } )

} )
