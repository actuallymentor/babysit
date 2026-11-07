import { describe, expect, it } from 'bun:test'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

import { parse_args } from '../src/cli/parse.js'

/*
 * Golden table: parse_args output for representative argv, frozen before the
 * flag registry refactor. Any diff is a grammar change.
 * Regenerate (only for an intended change): UPDATE_GOLDEN=1 bun test tests/parse_golden.test.js
 */

const FIXTURE = join( import.meta.dir, `fixtures/golden/parse_args.json` )

const CASES = [

    // Bare launch menu, names, own flags
    [],
    [ `My`, `Blog` ],
    [ `--name`, `x`, `--yolo`, `--port`, `3000` ],
    [ `--log`, `--docker` ],
    [ `--model`, `sonnet` ],
    [ `-x` ],
    [ `--help` ],
    [ `-h` ],
    [ `-v` ],
    [ `--version` ],
    [ `--config`, `/tmp/x.yaml` ],
    [ `--clone`, `--yes` ],
    [ `--devices` ],
    [ `--account`, `work` ],
    [ `123` ],

    // Agent start: own flags consumed after the agent word
    [ `claude` ],
    [ `claude`, `--yolo`, `--log`, `--model`, `sonnet` ],
    [ `claude`, `--log`, `--yolo` ],
    [ `claude`, `--log`, `out.log`, `--yolo` ],
    [ `claude`, `--log=out.log` ],
    [ `claude`, `--log` ],
    [ `codex`, `--sandbox`, `--loop`, `--name`, `feature 1` ],
    [ `codex`, `--clone`, `--name=feature` ],
    [ `opencode`, `--mudbox`, `--yolo`, `--port`, `3000`, `--port=8080:80` ],
    [ `claude`, `--devices` ],
    [ `claude`, `--adb`, `--ios`, `--docker` ],
    [ `claude`, `--ignore-host-agents-md` ],
    [ `claude`, `--account`, `work` ],
    [ `claude`, `--account=work`, `--yolo` ],
    [ `claude`, `--model`, `opus`, `--effort`, `high` ],
    [ `claude`, `--all` ],
    [ `claude`, `--all`, `foo` ],
    [ `claude`, `--usage` ],
    [ `claude`, `--dangerously-skip-permissions`, `--print`, `hi` ],
    [ `claude`, `-p`, `hello world` ],
    [ `claude`, `--no-color`, `x` ],
    [ `claude`, `--yolo`, `true` ],
    [ `claude`, `--yolo`, `false` ],
    [ `claude`, `--yolo`, `01` ],
    [ `claude`, `--`, `--yolo`, `--log`, `-h` ],
    [ `claude`, `--yolo`, `--` ],
    [ `claude`, `--`, `resume`, `2` ],
    [ `claude`, `--model`, `resume` ],
    [ `claude`, `--transcripts`, `off` ],
    [ `claude`, `--auth-check-agents`, `codex` ],
    [ `codex`, `-c`, `model=o3` ],
    [ `claude`, `--yolo=foo` ],
    [ `claude`, `--log=` ],
    [ `claude`, `-n25` ],
    [ `claude`, `--no-yolo` ],
    [ `claude`, `-h`, `x` ],
    [ `claude`, `--port`, `3000`, `--port`, `3001:80` ],
    [ `claude`, `--name`, `--yolo` ],
    [ `claude`, `--share`, `x` ],
    [ `claude`, `--force`, `x` ],
    [ `list`, `--all=false` ],
    [ `--usage` ],
    [ `--all` ],
    [ `claude`, `-n`, `5` ],

    // Agent resume
    [ `claude`, `resume`, `abc-123` ],
    [ `claude`, `resume`, `abc-123`, `--yolo`, `--model`, `x` ],
    [ `claude`, `resume`, `2` ],
    [ `claude`, `resume`, `2`, `--all` ],
    [ `claude`, `resume`, `2`, `-n25` ],
    [ `claude`, `resume`, `abc`, `--`, `-n25`, `abc` ],
    [ `codex`, `resume`, `01` ],

    // Bare resume
    [ `resume` ],
    [ `resume`, `--all` ],
    [ `resume`, `-n`, `25` ],
    [ `resume`, `-n25` ],
    [ `resume`, `--all`, `-n`, `3` ],
    [ `resume`, `-n`, `0` ],
    [ `resume`, `abc-123` ],
    [ `resume`, `abc-123`, `--all` ],
    [ `resume`, `1`, `--all` ],
    [ `resume`, `1`, `--yolo`, `--log` ],
    [ `resume`, `abc-123`, `--`, `-n25` ],
    [ `resume`, `abc`, `--model`, `abc` ],

    // Fork
    [ `fork`, `2` ],
    [ `fork`, `2`, `codex`, `--clone` ],
    [ `fork`, `2`, `--share`, `--mudbox` ],
    [ `fork`, `2`, `--clone`, `--takeover` ],
    [ `fork`, `abc-123`, `--no-history`, `--name`, `fresh eyes` ],
    [ `fork`, `2`, `--no-yolo`, `--no-docker`, `--no-loop` ],
    [ `fork`, `2`, `--regular`, `--model`, `x` ],
    [ `fork`, `2`, `--`, `--yolo`, `prompt` ],
    [ `fork`, `2`, `--share`, `--clone` ],
    [ `fork`, `2`, `--regular`, `--sandbox` ],
    [ `fork` ],
    [ `fork`, `2`, `codex`, `extra` ],
    [ `fork`, `2`, `--account`, `work` ],

    // List / watch / update
    [ `list` ],
    [ `list`, `--all` ],
    [ `list`, `--watch` ],
    [ `watch` ],
    [ `watch`, `--usage` ],
    [ `watch`, `--all`, `--interactive` ],
    [ `update` ],
    [ `update`, `--auto` ],

    // Config files
    [ `init` ],
    [ `init`, `x.yaml` ],
    [ `audit`, `--config`, `/tmp/dir/`, `--yes` ],
    [ `clean`, `--config`, `/tmp/x.yaml`, `--dry-run` ],
    [ `config` ],
    [ `config`, `--transcripts`, `off` ],
    [ `config`, `--auth-check-agents`, `claude,codex` ],

    // Session selectors
    [ `open` ],
    [ `open`, `2` ],
    [ `open`, `feature 1` ],
    [ `freeze`, `1`, `2` ],
    [ `unfreeze`, `all` ],
    [ `freeze` ],
    [ `archive` ],
    [ `archive`, `1`, `abc` ],
    [ `close`, `1`, `2` ],
    [ `close` ],
    [ `close`, `1`, `--dry-run` ],
    [ `restart`, `1` ],
    [ `restart`, `all`, `--force`, `--detach`, `--continue` ],
    [ `restart`, `1`, `--account`, `work` ],
    [ `restart`, `1`, `--account=work` ],
    [ `restart`, `all`, `2` ],
    [ `restart`, `1`, `--bogus` ],
    [ `restart` ],

    // Recovery
    [ `recover` ],
    [ `recover`, `1` ],
    [ `recover`, `--dry-run`, `--json` ],
    [ `recover`, `--no-continue` ],
    [ `recover`, `--boot` ],
    [ `recover`, `--shutdown` ],
    [ `recover`, `--shutdown`, `--json` ],
    [ `recover`, `1`, `--boot` ],
    [ `recover`, `init` ],
    [ `recover`, `init`, `--dry-run` ],
    [ `recover`, `1`, `2` ],

    // Shells, mode, prune, web
    [ `shell-init` ],
    [ `shell-init`, `zsh` ],
    [ `shell-init`, `tcsh` ],
    [ `mode` ],
    [ `prune` ],
    [ `prune`, `--list` ],
    [ `prune`, `--all` ],
    [ `web`, `init` ],
    [ `web` ],
    [ `web`, `--help` ],
    [ `web`, `key`, `add`, `phone` ],
    [ `web`, `key`, `list` ],
    [ `web`, `key`, `remove` ],
    [ `web`, `bogus` ],

    // Auth / doctor
    [ `auth` ],
    [ `auth`, `status` ],
    [ `auth`, `check`, `claude`, `--force` ],
    [ `auth`, `check`, `bogus` ],
    [ `auth`, `init`, `--remove` ],
    [ `auth`, `init`, `--no-linger` ],
    [ `auth`, `init`, `--claude-token`, `--name`, `work` ],
    [ `auth`, `init`, `--no-claude-token` ],
    [ `auth`, `accounts` ],
    [ `auth`, `accounts`, `remove`, `work` ],
    [ `auth`, `accounts`, `remove` ],
    [ `auth`, `bogus` ],
    [ `doctor`, `--auth` ],
    [ `doctor`, `--auth`, `opencode`, `--refresh` ],

    // Internal and validation errors
    [ `__monitor`, `abc`, `tok` ],
    [ `claude`, `--sandbox`, `--mudbox` ],
    [ `claude`, `--clone`, `--sandbox` ],
    [ `claude`, `--name`, `123` ],
    [ `claude`, `--name`, `a`, `--name`, `b` ],
    [ `codex`, `--account`, `work` ],
    [ `claude`, `--account=` ],
    [ `gemini` ],

]

// Errors are part of the grammar; absolute paths depend on the checkout
const run = argv => {
    try {
        const json = JSON.stringify( parse_args( [ ...argv ] ), ( key, value ) => value === undefined ? `<undefined>` : value )
        return JSON.parse( json.replaceAll( process.cwd(), `<cwd>` ) )
    } catch ( error ) {
        return { error: error.message }
    }
}

const actual = Object.fromEntries( CASES.map( argv => [ JSON.stringify( argv ), run( argv ) ] ) )

if( process.env.UPDATE_GOLDEN ) writeFileSync( FIXTURE, `${ JSON.stringify( actual, null, 2 ) }\n` )
const golden = JSON.parse( readFileSync( FIXTURE, `utf8` ) )

describe( `parse_args golden table`, () => {

    it( `covers every case`, () => {
        expect( Object.keys( golden ) ).toEqual( Object.keys( actual ) )
    } )

    for( const key of Object.keys( actual ) ) it( key, () => {
        expect( actual[ key ] ).toStrictEqual( golden[ key ] )
    } )

} )
