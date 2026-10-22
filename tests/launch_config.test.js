import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

import {
    build_launch_yaml, command_to_launch, default_launch, launch_flags, launch_to_command, validate_launch,
} from '../src/babysit/launch_config.js'
import { cmd_init } from '../src/cli/init.js'
import { launch_from_menu } from '../src/cli/launcher.js'
import { parse_args } from '../src/cli/parse.js'
import { write_default_config } from '../src/babysit/yaml.js'

let root

beforeEach( () => {
    root = mkdtempSync( join( tmpdir(), `babysit-launch-` ) )
} )

afterEach( () => rmSync( root, { recursive: true, force: true } ) )

describe( `launch: section`, () => {

    it( `ios and devices keys become device flags and round-trip through init`, () => {
        const ios = launch_to_command( default_launch( { ios: true } ) )
        expect( ios.flags ).toMatchObject( { ios: true, adb: false, devices: false } )

        const devices = launch_to_command( default_launch( { devices: true } ) )
        expect( devices.flags ).toMatchObject( { ios: true, adb: true, devices: true } )
        expect( launch_flags( default_launch( { devices: true } ) ) ).toEqual( [ `--devices` ] )

        // --devices is written back as the one key the user typed
        expect( command_to_launch( parse_args( [ `claude`, `--devices` ] ) ) ).toMatchObject( { devices: true, adb: false, ios: false } )
        expect( command_to_launch( parse_args( [ `claude`, `--ios` ] ) ) ).toMatchObject( { devices: false, adb: false, ios: true } )

        expect( validate_launch( { agent: `claude`, ios: `yes` } ).errors ).toEqual( [ expect.stringContaining( `launch.ios` ) ] )
    } )

    it( `strict mode requires the section and its agent; other keys default`, () => {
        expect( validate_launch( default_launch(), { strict: true } ).errors ).toEqual( [] )

        const { errors, launch } = validate_launch( { agent: `codex`, yolo: null }, { strict: true } )
        expect( errors ).toEqual( [] )
        expect( launch ).toEqual( default_launch( { agent: `codex` } ) )
        expect( validate_launch( { yolo: true }, { strict: true } ).errors ).toEqual( [ `launch.agent is required` ] )

        expect( validate_launch( null, { strict: true } ).errors ).toEqual( [ `missing launch: section` ] )
    } )

    it( `rejects bad values, unknown keys, and clone outside regular mode`, () => {
        const { errors } = validate_launch( {
            ...default_launch(), agent: `gpt`, yolo: `yes`, log: ``, ports: `3000`, extra: 1, clone: true, mode: `sandbox`,
        }, { strict: true } )
        expect( errors ).toEqual( expect.arrayContaining( [
            expect.stringContaining( `launch.agent must be one of` ),
            `launch.yolo must be true or false`,
            expect.stringContaining( `launch.log must be` ),
            expect.stringContaining( `launch.ports must be` ),
            `launch.extra is not a known key`,
            `launch.clone cannot be combined with mode: sandbox`,
        ] ) )
    } )

    it( `lenient mode keeps only the valid keys a file declares`, () => {
        const { declared, errors } = validate_launch( { agent: `codex`, docker: `no` } )
        expect( declared ).toEqual( { agent: `codex` } )
        expect( errors ).toEqual( [ `launch.docker must be true or false` ] )
    } )

    it( `builds the same command as the equivalent CLI flags`, () => {
        const launch = default_launch( {
            agent: `codex`, mode: `sandbox`, yolo: true, docker: true, ports: [ 3000, `8080:80` ], log: true,
            ignore_host_agents_md: true, args: [ `--yolo`, `-m`, `gpt` ],
        } )
        const cmd = launch_to_command( launch, { config_path: `/x/a.yaml`, name: `a` } )
        const cli = parse_args( [ `codex`, `--sandbox`, `--yolo`, `--docker`, `--port`, `3000`, `--port`, `8080:80`, `--log`, `--ignore-host-agents-md`, `--name`, `a`, `--config`, `/x/a.yaml` ] )

        expect( cmd.flags ).toEqual( cli.flags )
        expect( cmd.agent ).toBe( `codex` )
        // Agent args stay literal even when they collide with Babysit flag names
        expect( cmd.passthrough ).toEqual( [ `--yolo`, `-m`, `gpt` ] )
        expect( launch_flags( launch ) ).toEqual( [ `--yolo`, `--docker`, `--sandbox`, `--ignore-host-agents-md`, `--port=3000`, `--port=8080:80`, `--log` ] )
        expect( launch_to_command( { ...launch, name: `own` }, { name: `a` } ).flags.name ).toBe( `own` )
        expect( () => launch_to_command( default_launch(), { name: `01` } ) ).toThrow( /only digits/ )
    } )

    it( `round-trips a menu command through the yaml init writes`, () => {
        const cmd = parse_args( [ `claude`, `--clone`, `--loop`, `--name`, `fix "it"` ] )
        const launch = command_to_launch( cmd )
        expect( launch ).toMatchObject( { agent: `claude`, clone: true, loop: true, name: `fix "it"`, mode: `regular` } )

        const parsed = parse( build_launch_yaml( launch ) ).launch
        // Defaults are commented out, so the live keys are the ones that differ
        expect( parsed ).toEqual( { agent: `claude`, clone: true, loop: true, name: `fix "it"` } )
        expect( default_launch( parsed ) ).toEqual( launch )
        expect( default_launch( parse( build_launch_yaml( default_launch( { log: `a b.log`, args: [ `--model`, `x` ] } ) ) ).launch ) ).toEqual( default_launch( { log: `a b.log`, args: [ `--model`, `x` ] } ) )
        expect( parse( build_launch_yaml( default_launch() ) ).launch ).toEqual( { agent: `claude` } )
    } )

} )

describe( `launch: consumers`, () => {

    it( `init writes the menu's non-default choices live and defaults commented`, async () => {
        const messages = []
        await cmd_init( { session_id: `team.yaml` }, {
            choose: async () => command_to_launch( parse_args( [ `codex`, `--yolo`, `--docker` ] ) ),
            write: write_default_config, cwd: root, print: message => messages.push( message ),
        } )
        const { launch } = parse( readFileSync( join( root, `team.yaml` ), `utf8` ) )
        expect( launch ).toEqual( { agent: `codex`, yolo: true, docker: true } )
        expect( readFileSync( join( root, `team.yaml` ), `utf8` ) ).toContain( `# adb: false` )
        expect( validate_launch( launch, { strict: true } ).errors ).toEqual( [] )
        expect( messages.at( -1 ) ).toBe( `Use it with: babysit --config team.yaml` )

        await cmd_init( { session_id: `other.yaml` }, { choose: async () => null, cwd: root, print: message => messages.push( message ) } )
        expect( messages.at( -1 ) ).toMatch( /nothing written/ )
    } )

    it( `the menu opens prefilled from a file, including its Advanced rows`, async () => {
        const config = join( root, `a.yaml` )
        writeFileSync( config, `launch:\n    agent: codex\n    mode: mudbox\n    clone: true\n    ports: [3000]\n    args: ["-m", "x"]\n    log: out.log\n    name: from file\n` )

        let opened
        const cmd = await launch_from_menu( {
            config,
            // Submitting the prefilled menu untouched
            menu: async options => {
                opened = options
                const { initial } = options
                return { ...parse_args( [ initial.agent, `--${ initial.mode }`, `--log=${ initial.log }`, ...initial.ports.map( port => `--port=${ port }` ), `--name`, options.name ] ), passthrough: initial.args }
            },
        } )

        expect( opened ).toEqual( { name: `from file`, initial: { agent: `codex`, mode: `mudbox`, clone: true, ports: [ 3000 ], args: [ `-m`, `x` ], log: `out.log` }, fork_key: true } )
        expect( cmd ).toMatchObject( { verb: `start`, agent: `codex`, passthrough: [ `-m`, `x` ], flags: { mudbox: true, log: `out.log`, config, name: `from file` } } )
        expect( cmd.flags.ports ).toEqual( parse_args( [ `codex`, `--port`, `3000` ] ).flags.ports )

        // Flags typed on the command line prefill the switches and carry ports and log
        const typed = await launch_from_menu( {
            flags: parse_args( [ `--yolo`, `--sandbox`, `--port`, `5173`, `--log=run.log` ] ).flags,
            menu: async options => ( opened = options, parse_args( [ `claude`, `--yolo`, `--sandbox` ] ) ),
        } )
        expect( opened.initial ).toEqual( { yolo: true, mode: `sandbox`, ports: [ `5173:5173` ], log: `run.log` } )

        // --devices shows as the one Devices switch; a lone --ios sits under Advanced
        await launch_from_menu( { flags: parse_args( [ `--devices` ] ).flags, menu: async options => ( opened = options, null ) } )
        expect( opened.initial ).toEqual( { devices: true } )
        await launch_from_menu( { flags: parse_args( [ `--ios` ] ).flags, menu: async options => ( opened = options, null ) } )
        expect( opened.initial ).toEqual( { ios: true } )

        // A typed name wins; a missing file falls back to the plain menu
        const plain = await launch_from_menu( { name: `typed`, config: join( root, `missing.yaml` ), menu: async options => ( opened = options, null ) } )
        expect( plain ).toBeNull()
        expect( opened ).toEqual( { name: `typed`, initial: {}, fork_key: true } )
    } )

} )
