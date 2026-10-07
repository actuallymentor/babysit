import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { cmd_init } from '../src/cli/init.js'
import { load_config, load_clone_config } from '../src/babysit/yaml.js'
import { parse_args } from '../src/cli/parse.js'
import { workspace_config_hash } from '../src/sessions/recovery.js'

describe( `babysit init and --config`, () => {

    it( `init asks for a name when none is given and validates the extension`, async () => {
        const writes = []
        const messages = []
        await cmd_init( { session_id: null }, { ask: async () => `team.yaml`, write: ( cwd, options ) => writes.push( options.file ) && `/w/team.yaml`, print: m => messages.push( m ), cwd: `/w` } )
        expect( writes ).toEqual( [ `team.yaml` ] )
        expect( messages[1] ).toContain( `--config team.yaml` )

        await cmd_init( { session_id: `babysit.yaml` }, { ask: async () => {
            throw new Error( `must not ask` )
        }, write: () => `/w/babysit.yaml`, print: m => messages.push( m ), cwd: `/w` } )
        expect( messages.at( -1 ) ).toBe( `Wrote /w/babysit.yaml` )

        await expect( cmd_init( { session_id: `notes.txt` }, { write: () => `` } ) ).rejects.toThrow( /\.yaml or \.yml/ )
    } )

    it( `parses --config into an absolute path and init takes a file argument`, () => {
        expect( parse_args( [ `claude`, `--config`, `team.yaml` ] ).flags.config ).toBe( join( process.cwd(), `team.yaml` ) )
        expect( parse_args( [ `claude` ] ).flags.config ).toBe( false )
        expect( parse_args( [ `init`, `team.yaml` ] ) ).toMatchObject( { verb: `init`, session_id: `team.yaml` } )
        // A bare launch with only --config still opens the menu, name included
        expect( parse_args( [ `--config`, `team.yaml` ] ) ).toMatchObject( { verb: `launch`, flags: { config: join( process.cwd(), `team.yaml` ), name: false } } )
        expect( parse_args( [ `feature`, `one`, `--config=team.yaml` ] ) ).toMatchObject( { verb: `launch`, flags: { name: `feature one` } } )
        expect( parse_args( [ `--config`, `team.yaml`, `--yolo` ] ).verb ).toBe( `help` )
    } )

    it( `loads an explicit config file for launch, clone settings, and the recovery hash`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-config-` ) )
        try {
            const config_path = join( dir, `team.yaml` )
            writeFileSync( config_path, `config:\n    idle_timeout_s: 7\n    clone:\n        mode: copy\nbabysit:\n    - on: idle\n      do: enter\n` )
            writeFileSync( join( dir, `babysit.yaml` ), `config:\n    idle_timeout_s: 99\n` )

            const { config, rules } = load_config( dir, { config_path } )
            expect( config.idle_timeout_s ).toBe( 7 )
            expect( rules ).toHaveLength( 1 )
            expect( load_config( dir ).config.idle_timeout_s ).toBe( 99 )
            expect( load_clone_config( dir, { config_path } ).mode ).toBe( `copy` )
            expect( workspace_config_hash( dir, config_path ) ).not.toBe( workspace_config_hash( dir ) )
            expect( () => load_config( dir, { config_path: join( dir, `missing.yaml` ) } ) ).toThrow( /not found/ )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }
    } )

} )
