import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { build_launch_yaml, default_launch } from '../src/babysit/launch_config.js'
import { cmd_audit, line_diff, strict_errors, yaml_indent } from '../src/cli/audit.js'
import { parse_args } from '../src/cli/parse.js'

let dir

beforeEach( () => {
    dir = realpathSync( mkdtempSync( join( tmpdir(), `babysit-audit-` ) ) )
} )

afterEach( () => {
    rmSync( dir, { recursive: true, force: true } )
} )

const write = ( file, text ) => writeFileSync( join( dir, file ), text )
const read = file => readFileSync( join( dir, file ), `utf-8` )

// A hand-written file: comments, custom order, two-space indent, gaps to fill
const PARTIAL = `# My review session
launch:
  # who does the work
  agent: codex # the fast one
  yolo: true
  mode: regular
  ports: [ 3000 ]

# keep these rules
babysit:
  - on: idle
    do: "Keep going"
`

/**
 * Run the audit like the CLI does, answering prompts from a table.
 * @param {Object} [options]
 * @param {string} [options.target=dir] - --config value
 * @param {Array<[RegExp, string]>} [options.answers] - First matching pattern answers; unmatched prompts get an empty answer
 * @param {boolean} [options.interactive=true] - TTY
 * @param {boolean} [options.yes=false] - --yes
 */
const audit = async ( { target = dir, answers = [], interactive = true, yes = false } = {} ) => {

    const asked = []
    const lines = []
    const code = await cmd_audit( { flags: { config: target, yes } }, {
        interactive,
        print: line => lines.push( line ),
        ask: async question => {
            asked.push( question )
            if( !interactive ) throw new Error( `prompted without a terminal: ${ question }` )
            return answers.find( ( [ pattern ] ) => pattern.test( question ) )?.[1] ?? ``
        },
    } )

    return { code, asked, output: lines.join( `\n` ) }

}

describe( `babysit audit`, () => {

    it( `parses as its own verb with --config and --yes`, () => {
        const cmd = parse_args( [ `audit`, `--config`, `sessions/`, `--yes` ] )
        expect( cmd.verb ).toBe( `audit` )
        expect( cmd.flags.config ).toEndWith( `/sessions` )
        expect( cmd.flags.yes ).toBe( true )
    } )

    it( `fills missing keys with defaults and keeps comments, order and indent`, async () => {
        write( `review.yaml`, PARTIAL )
        const { code, output } = await audit( { answers: [ [ /^ *Write/, `y` ] ] } )

        const text = read( `review.yaml` )
        expect( code ).toBe( 0 )
        expect( output ).toContain( `launch.docker is required` )
        expect( strict_errors( text ) ).toEqual( [] )
        for( const comment of [ `# My review session`, `# who does the work`, `# the fast one`, `# keep these rules` ] ) expect( text ).toContain( comment )
        // Existing values untouched; new keys slot in canonical order
        expect( text ).toContain( `  yolo: true\n  mode: regular\n  docker: false\n` )
        expect( text ).toContain( `  ports: [ 3000 ]\n  log: false\n  args: []\n` )
        expect( text ).toMatch( /babysit:\n {2}- on: idle/ )
        // Diff shows only additions
        expect( output ).toContain( `+   docker: false` )
        expect( output ).not.toMatch( /^ {2}- {3}/m )
    } )

    it( `asks for a missing agent instead of assuming claude`, async () => {
        write( `a.yaml`, build_launch_yaml( default_launch() ).replace( /^ {4}agent: claude\n/m, `` ) )
        const { asked, code } = await audit( { answers: [ [ /Agent \[/, `2` ], [ /Write/, `` ] ] } )
        expect( asked.some( question => /Agent \[1-/.test( question ) ) ).toBe( true )
        expect( parse( read( `a.yaml` ) ).launch.agent ).toBe( `codex` )
        expect( code ).toBe( 0 )
    } )

    it( `resets an invalid value on y and keeps it on N`, async () => {
        write( `a.yaml`, build_launch_yaml( default_launch() ).replace( `mode: regular`, `mode: turbo` ).replace( `yolo: false`, `yolo: maybe` ) )
        const { code, output } = await audit( { answers: [ [ /launch\.mode/, `y` ], [ /Write/, `y` ] ] } )

        const launch = parse( read( `a.yaml` ) ).launch
        expect( launch.mode ).toBe( `regular` )
        expect( launch.yolo ).toBe( `maybe` )
        expect( output ).toContain( `Still failing` )
        expect( code ).toBe( 1 )
    } )

    it( `never flags valid lists or maps as invalid`, async () => {
        write( `a.yaml`, PARTIAL )
        const { asked } = await audit( { answers: [ [ /Write/, `n` ] ] } )
        expect( asked.filter( question => /launch\.ports/.test( question ) ) ).toEqual( [] )
    } )

    it( `removes unknown keys one by one`, async () => {
        write( `a.yaml`, build_launch_yaml( default_launch() ).replace( `    yolo: false\n`, `    yolo: false\n    turbo: true\n    colour: red\n` ) )
        const { code } = await audit( { answers: [ [ /launch\.turbo/, `y` ], [ /Write/, `y` ] ] } )
        const launch = parse( read( `a.yaml` ) ).launch
        expect( launch ).not.toHaveProperty( `turbo` )
        expect( launch.colour ).toBe( `red` )
        expect( code ).toBe( 1 )
    } )

    it( `fixes clone combined with a container mode`, async () => {
        write( `a.yaml`, build_launch_yaml( default_launch( { mode: `sandbox`, clone: true } ) ) )
        const { code } = await audit( { answers: [ [ /Set clone: false/, `y` ], [ /Write/, `y` ] ] } )
        expect( parse( read( `a.yaml` ) ).launch.clone ).toBe( false )
        expect( code ).toBe( 0 )
    } )

    it( `asks about each missing behaviour key and never offers optional ones`, async () => {
        write( `a.yaml`, `launch:\n    agent: claude\n    ports: []\n` )
        const { code, asked } = await audit( { answers: [
            [ /Mode \[/, `2` ], [ /launch\.yolo/, `y` ], [ /launch\.docker/, `yes` ], [ /Write/, `y` ],
        ] } )

        const parsed = parse( read( `a.yaml` ) )
        expect( code ).toBe( 0 )
        expect( parsed.launch ).toMatchObject( { mode: `sandbox`, yolo: true, docker: true, adb: false, clone: false, loop: false, ignore_host_agents_md: false, log: false, args: [] } )
        // Sandbox cannot clone, so clone is not asked; ports, log and args never are
        expect( asked.filter( question => /\bis missing|Mode \[/.test( question ) ).map( question => question.match( /launch\.(\w+)/ )?.[1] ?? `mode` ) )
            .toEqual( [ `mode`, `yolo`, `docker`, `adb`, `loop`, `ignore_host_agents_md` ] )
        expect( asked.join( `\n` ) ).not.toMatch( /name|timeout|initial_prompt|commands|rule/ )
        expect( parsed ).not.toHaveProperty( `config` )
        expect( parsed ).not.toHaveProperty( `babysit` )
        expect( parsed.launch ).not.toHaveProperty( `name` )
    } )

    it( `asks about clone in regular mode`, async () => {
        write( `a.yaml`, `launch:\n    agent: claude\n    mode: regular\n` )
        await audit( { answers: [ [ /launch\.clone/, `y` ], [ /Write/, `y` ] ] } )
        expect( parse( read( `a.yaml` ) ).launch.clone ).toBe( true )
    } )

    it( `leaves the file alone when the write is declined`, async () => {
        write( `a.yaml`, PARTIAL )
        const { code } = await audit( { answers: [ [ /Write/, `n` ] ] } )
        expect( read( `a.yaml` ) ).toBe( PARTIAL )
        expect( code ).toBe( 1 )
    } )

    it( `audits exactly the directory-launch set`, async () => {
        write( `good.yaml`, build_launch_yaml( default_launch() ) )
        write( `bad.yml`, PARTIAL )
        write( `notes.txt`, `launch: nope` )
        mkdirSync( join( dir, `nested` ) )
        writeFileSync( join( dir, `nested`, `deep.yaml` ), `launch: 1` )

        const { code, output } = await audit( { interactive: false } )
        expect( output ).toContain( `good.yaml: ok` )
        expect( output ).toContain( `bad.yml: 7 problems` )
        expect( output ).not.toContain( `notes.txt` )
        expect( output ).not.toContain( `deep.yaml` )
        expect( output ).toContain( `1 of 2 failing: bad.yml` )
        expect( code ).toBe( 1 )
    } )

    it( `only reports without a terminal`, async () => {
        write( `a.yaml`, PARTIAL )
        const { code, asked } = await audit( { interactive: false } )
        expect( asked ).toEqual( [] )
        expect( read( `a.yaml` ) ).toBe( PARTIAL )
        expect( code ).toBe( 1 )

        write( `a.yaml`, build_launch_yaml( default_launch() ) )
        expect( ( await audit( { interactive: false } ) ).code ).toBe( 0 )
    } )

    it( `applies required fixes with --yes without asking`, async () => {
        write( `a.yaml`, PARTIAL.replace( `mode: regular`, `mode: turbo\n  turbo: true` ) )
        write( `b.yaml`, `launch:\n    yolo: true\n` )
        const { code, asked, output } = await audit( { interactive: false, yes: true } )

        expect( asked ).toEqual( [] )
        const launch = parse( read( `a.yaml` ) ).launch
        expect( launch.mode ).toBe( `regular` )
        expect( launch ).not.toHaveProperty( `turbo` )
        expect( launch ).not.toHaveProperty( `name` )
        expect( parse( read( `a.yaml` ) ) ).not.toHaveProperty( `config` )
        // No terminal, no agent: that file still fails
        expect( output ).toContain( `run babysit audit in a terminal to pick one` )
        expect( output ).toContain( `1 of 2 failing: b.yaml` )
        expect( code ).toBe( 1 )
    } )

    it( `creates the launch section for a file without one`, async () => {
        write( `a.yaml`, `# only rules here\nbabysit: []\n` )
        const { code } = await audit( { target: join( dir, `a.yaml` ), answers: [ [ /Agent \[/, `opencode` ], [ /Write/, `y` ] ] } )
        const text = read( `a.yaml` )
        // The leading comment belongs to the key it sat on
        expect( text ).toStartWith( `launch:\n    agent: opencode\n` )
        expect( text ).toEndWith( `# only rules here\nbabysit: []\n` )
        expect( parse( text ).launch.agent ).toBe( `opencode` )
        expect( code ).toBe( 0 )
    } )

    it( `keeps the comments of a null launch: it replaces`, async () => {
        write( `a.yaml`, `launch:   # TODO\n  # inner\nconfig: {}\n` )
        write( `b.yaml`, `# top\nlaunch:\n# after\nconfig:\n` )
        await audit( { answers: [ [ /Agent \[/, `claude` ], [ /Write/, `y` ] ] } )
        expect( read( `a.yaml` ) ).toStartWith( `launch:\n    # TODO\n    # inner\n    agent: claude\n` )
        expect( read( `b.yaml` ) ).toStartWith( `# top\nlaunch:\n    # after\n    agent: claude\n` )
    } )

    it( `refuses to edit through a launch: alias`, async () => {
        const text = `base: &base\n  agent: claude\nlaunch: *base\n`
        write( `a.yaml`, text )
        const { code, output } = await audit( { yes: true } )
        expect( output ).toContain( `launch: is an alias; inline it to audit` )
        expect( read( `a.yaml` ) ).toBe( text )
        expect( code ).toBe( 1 )
    } )

    it( `names a missing --config path`, async () => {
        const missing = join( dir, `nope.yaml` )
        await expect( audit( { target: missing } ) ).rejects.toThrow( `No such file or directory: ${ missing }` )
    } )

    it( `reports yaml syntax errors without touching the file`, async () => {
        write( `a.yaml`, `launch:\n  agent: [unclosed\n` )
        const { code, output } = await audit( { yes: true } )
        expect( output ).toContain( `a.yaml: 1 problem` )
        expect( read( `a.yaml` ) ).toBe( `launch:\n  agent: [unclosed\n` )
        expect( code ).toBe( 1 )
    } )

} )

describe( `audit helpers`, () => {

    it( `detects the file's indent`, () => {
        expect( yaml_indent( PARTIAL ) ).toBe( 2 )
        expect( yaml_indent( build_launch_yaml( default_launch() ) ) ).toBe( 4 )
        expect( yaml_indent( `a: 1\n` ) ).toBe( 4 )
    } )

    it( `diffs lines with context`, () => {
        const before = [ `a`, `b`, `c`, `d`, `e`, `f`, `g` ].join( `\n` )
        const after = [ `a`, `b`, `c`, `X`, `e`, `f`, `g` ].join( `\n` )
        expect( line_diff( before, after, { context: 1 } ) ).toEqual( [ `  …`, `  c`, `- d`, `+ X`, `  e`, `  …` ] )
    } )

} )
