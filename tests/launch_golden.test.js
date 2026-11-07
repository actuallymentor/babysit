import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { parse_args } from '../src/cli/parse.js'
import { help_topic } from '../src/cli/help_topics.js'
import { merge_resume_flags } from '../src/cli/resume.js'
import { mode_from_modifiers } from '../src/cli/monitor.js'
import { build_launch_yaml, command_to_launch, default_launch, launch_flags, launch_to_command } from '../src/babysit/launch_config.js'

/*
 * Golden table for the code paths fed by the flag registry: launch yaml <-> flags,
 * stored modifiers -> flags/mode, and help topic routing.
 * Regenerate (only for an intended change): UPDATE_GOLDEN=1 bun test tests/launch_golden.test.js
 */

const FIXTURE = join( import.meta.dir, `fixtures/golden/launch.json` )

const LAUNCHES = [
    {},
    { yolo: true, docker: true, adb: true, ios: true, devices: true, clone: true, loop: true, ignore_host_agents_md: true, ports: [ 3000, `8080:80` ], log: true },
    { mode: `sandbox`, log: `out.log`, agent: `codex`, args: [ `--model`, `o3` ] },
    { mode: `mudbox`, name: `x`, ios: true },
]

const ARGVS = [
    [ `claude` ],
    [ `claude`, `--yolo`, `--devices`, `--loop`, `--log`, `--port`, `3000`, `--model`, `x` ],
    [ `codex`, `--mudbox`, `--ignore-host-agents-md`, `--log=out.log`, `--name`, `n` ],
    [ `opencode`, `--sandbox`, `--adb`, `--docker` ],
    [ `claude`, `--clone`, `--ios`, `--account`, `w` ],
]

const MODIFIERS = [
    [],
    [ `yolo`, `sandbox`, `mudbox`, `docker`, `adb`, `ios`, `clone`, `loop`, `ignore-host-agents-md` ],
    [ `loop`, `unknown` ],
]

const RESUME_FLAGS = [
    {},
    { yolo: true, log: ``, ports: [ `3000` ], name: `n` },
    { loop: true, log: false, ports: [], devices: true },
]

const HELP_ARGVS = [
    [ `--help` ], [ `help` ], [ `claude`, `--help` ], [ `claude`, `resume`, `2`, `--help` ], [ `help`, `auth`, `init` ],
    [ `auth`, `init`, `--help` ], [ `--name`, `auth`, `--help` ], [ `--config`, `x`, `fork`, `-h` ], [ `-n`, `5`, `resume`, `-h` ],
    [ `model`, `--sort`, `intelligence`, `--help` ], [ `restart`, `--account`, `work`, `--help` ], [ `claude`, `--`, `-h` ],
    [ `bogus`, `--help` ], [ `web`, `key`, `--help` ], [ `usage`, `--help` ], [ `effort`, `-h` ],
]

const actual = {
    launch_flags: LAUNCHES.map( launch => launch_flags( default_launch( launch ) ) ),
    launch_to_command: LAUNCHES.map( launch => launch_to_command( default_launch( launch ), { config_path: `/c.yaml`, name: `fallback` } ) ),
    command_to_launch: ARGVS.map( argv => command_to_launch( parse_args( argv ) ) ),
    build_launch_yaml: LAUNCHES.map( launch => build_launch_yaml( default_launch( launch ) ) ),
    mode_from_modifiers: MODIFIERS.map( modifiers => mode_from_modifiers( modifiers ) ),
    merge_resume_flags: MODIFIERS.flatMap( modifiers => RESUME_FLAGS.map( flags => merge_resume_flags( modifiers, flags, { name: `stored`, ports: [ 1 ] } ) ) ),
    help_topic: HELP_ARGVS.map( argv => help_topic( argv )?.split( `\n` )[0] ?? null ),
}

const normalised = JSON.parse( JSON.stringify( actual, ( key, value ) => value === undefined ? `<undefined>` : value ) )
if( process.env.UPDATE_GOLDEN ) writeFileSync( FIXTURE, `${ JSON.stringify( normalised, null, 2 ) }\n` )
const golden = JSON.parse( readFileSync( FIXTURE, `utf8` ) )

describe( `launch conversions golden table`, () => {

    for( const key of Object.keys( normalised ) ) it( key, () => {
        expect( normalised[ key ] ).toStrictEqual( golden[ key ] )
    } )

} )
