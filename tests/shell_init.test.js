import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { follow_workspace, shell_init_script } from '../src/cli/shell_init.js'
import { cmd_open } from '../src/cli/open.js'
import { parse_args } from '../src/cli/parse.js'

describe( `babysit shell-init`, () => {

    it( `prints a POSIX wrapper for bash and zsh, and a fish one`, () => {

        expect( shell_init_script( `bash` ) ).toContain( `BABYSIT_CD_FILE="$babysit_cd_file" command babysit "$@"` )
        // zsh reserves $status, so the wrapper must not assign it
        expect( shell_init_script( `zsh` ) ).not.toMatch( /\bstatus=/ )
        expect( shell_init_script( `fish` ) ).toStartWith( `function babysit` )

    } )

    it( `parses an optional shell and rejects unknown ones`, () => {

        expect( parse_args( [ `shell-init` ] ) ).toMatchObject( { verb: `shell-init`, shell: null } )
        expect( parse_args( [ `shell-init`, `fish` ] ).shell ).toBe( `fish` )
        expect( () => parse_args( [ `shell-init`, `tcsh` ] ) ).toThrow( `Unknown shell: tcsh` )

    } )

} )

describe( `follow_workspace`, () => {

    const directory = mkdtempSync( join( tmpdir(), `babysit-follow-` ) )
    const cd_file = join( directory, `cd` )

    it( `hands the workspace to the wrapper's file`, () => {

        writeFileSync( cd_file, `` )
        expect( follow_workspace( directory, { cwd: `/`, env: { BABYSIT_CD_FILE: cd_file } } ) ).toBe( true )
        expect( readFileSync( cd_file, `utf8` ) ).toBe( directory )

    } )

    it( `never creates a file a stale variable points at, and skips the current or missing directories`, () => {

        const stale = join( directory, `gone` )
        expect( follow_workspace( directory, { cwd: `/`, env: { BABYSIT_CD_FILE: stale }, write_file: () => { throw new Error( `wrote` ) } } ) ).toBe( false )
        expect( follow_workspace( directory, { cwd: directory, env: { BABYSIT_CD_FILE: cd_file } } ) ).toBe( false )
        expect( follow_workspace( join( directory, `pruned` ), { cwd: `/`, env: { BABYSIT_CD_FILE: cd_file } } ) ).toBe( false )
        rmSync( directory, { recursive: true, force: true } )

    } )

} )

describe( `cmd_open workspace follow`, () => {

    it( `follows the clone after detaching, even for a raw tmux name`, async () => {

        const followed = []
        await cmd_open( { session_id: `babysit_c1` }, {
            has_session_fn: async () => true,
            list_stored_sessions_fn: () => [ { babysit_id: `c1`, tmux_session: `babysit_c1`, pwd: `/repo`, clone_path: `/clones/c1` } ],
            attach_session_fn: () => followed.push( `attached` ),
            follow_workspace_fn: workspace => followed.push( workspace ),
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )
        expect( followed ).toEqual( [ `attached`, `/clones/c1` ] )

    } )

} )
