import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import { build_launch_yaml, default_launch } from '../src/babysit/launch_config.js'
import { load_config } from '../src/babysit/yaml.js'
import { cmd_audit, line_diff, strict_errors, yaml_indent } from '../src/cli/audit.js'
import { read_launch_dir } from '../src/cli/compose.js'
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

    it( `offers name, tuning keys, a clone section and rule skeletons`, async () => {
        write( `7.yaml`, build_launch_yaml( default_launch( { clone: true } ) ) )
        const { code } = await audit( { answers: [ [ /initial_prompt/, `n` ], [ /\[y\/N\]/, `y` ], [ /Write/, `y` ] ] } )

        const text = read( `7.yaml` )
        const parsed = parse( text )
        expect( code ).toBe( 0 )
        // Digit-only stems keep the extension, like directory launches
        expect( parsed.launch.name ).toBe( `7.yaml` )
        expect( parsed.config ).toMatchObject( { idle_timeout_s: 300, watchdog_idle_s: 1_800, watchdog_waiting_s: 3_600, yolo_approve_dangerous_commands: true, isolate_dependencies: true, commands: {} } )
        expect( parsed.config ).not.toHaveProperty( `initial_prompt` )
        expect( parsed.config.clone ).toEqual( { mode: `git`, carry: [ `.env`, `.env.*`, `.notes`, `babysit.yaml` ], changes: false, depth: null, exclude: [ `node_modules` ] } )
        expect( parsed.babysit ).toEqual( [] )
        expect( text ).toContain( `# Supervision rules` )
        expect( text ).toContain( `#     do: ./IDLE.md` )
        expect( text ).toMatch( /\nconfig:\n {4}# Seconds without new output/ )

        // The result is a config Babysit actually loads and launches
        const { config, rules } = load_config( dir, { config_path: join( dir, `7.yaml` ) } )
        expect( config.idle_timeout_s ).toBe( 300 )
        expect( rules ).toEqual( [] )
        expect( read_launch_dir( dir ).errors ).toEqual( [] )
    } )

    it( `writes the generated prompt as a literal block when asked`, async () => {
        write( `a.yaml`, build_launch_yaml( default_launch() ) )
        await audit( { answers: [ [ /initial_prompt/, `y` ], [ /Write/, `y` ] ] } )
        const text = read( `a.yaml` )
        expect( text ).toContain( `initial_prompt: |` )
        expect( parse( text ).config.initial_prompt.length ).toBeGreaterThan( 50 )
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

    it( `applies required fixes with --yes and skips optional offers`, async () => {
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
