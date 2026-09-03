import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readlinkSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
    acquire_clone_lock,
    clone_branch_name,
    prepare_clone_workspace,
    sweep_stale_clone_partials,
} from '../src/clone.js'

const run_git = ( cwd, args, { allow_failure = false } = {} ) => {

    const result = spawnSync( `git`, [ `-C`, cwd, ...args ], {
        encoding: `utf8`,
        stdio: [ `ignore`, `pipe`, `pipe` ],
    } )

    if( result.status === 0 ) return String( result.stdout || `` ).trim()
    if( allow_failure ) return null

    throw new Error( String( result.stderr || result.stdout || result.error?.message ).trim() )

}

const initialize_repository = directory => {

    run_git( directory, [ `init`, `-b`, `main` ] )
    writeFileSync( join( directory, `tracked.txt` ), `tracked\n` )
    run_git( directory, [ `add`, `tracked.txt` ] )
    run_git( directory, [
        `-c`, `user.name=Babysit Test`,
        `-c`, `user.email=babysit@example.invalid`,
        `commit`, `-m`, `initial`,
    ] )

}

describe( `clone workspace preparation`, () => {

    let directory
    let source
    let clones_dir

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-test-` ) )
        source = join( directory, `source` )
        clones_dir = join( directory, `clones` )
        mkdirSync( source )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `copies every entry including dependencies and preserves symlink text`, () => {

        mkdirSync( join( source, `node_modules`, `package` ), { recursive: true } )
        writeFileSync( join( source, `node_modules`, `package`, `index.js` ), `export default 1\n` )
        writeFileSync( join( source, `.hidden` ), `hidden\n` )
        symlinkSync( `node_modules/package`, join( source, `package-link` ) )

        const result = prepare_clone_workspace( {
            source,
            clone_id: `clone-one`,
            clones_dir,
        } )

        expect( result ).toMatchObject( {
            original_workspace: source,
            workspace: join( clones_dir, `clone-one` ),
            clone_path: join( clones_dir, `clone-one` ),
            clone_id: `clone-one`,
            clone_branch: null,
            git_repository: false,
            git_repository_kind: `none`,
            reused: false,
        } )
        expect( readFileSync( join( result.workspace, `node_modules`, `package`, `index.js` ), `utf8` ) ).toBe( `export default 1\n` )
        expect( readFileSync( join( result.workspace, `.hidden` ), `utf8` ) ).toBe( `hidden\n` )
        expect( readlinkSync( join( result.workspace, `package-link` ) ) ).toBe( `node_modules/package` )
        expect( readdirSync( join( clones_dir, `.babysit-state`, `partials` ) ) ).toEqual( [] )

    } )

    it( `reuses only a completed matching clone without recopying it`, () => {

        writeFileSync( join( source, `original.txt` ), `original\n` )

        const first = prepare_clone_workspace( {
            source,
            clone_id: `reusable`,
            clones_dir,
        } )
        writeFileSync( join( first.workspace, `agent-change.txt` ), `keep me\n` )

        const second = prepare_clone_workspace( {
            source,
            clone_id: `reusable`,
            clones_dir,
        } )

        expect( second.reused ).toBe( true )
        expect( readFileSync( join( second.workspace, `agent-change.txt` ), `utf8` ) ).toBe( `keep me\n` )

    } )

    it( `refuses an unmanaged existing destination`, () => {

        mkdirSync( join( clones_dir, `occupied` ), { recursive: true } )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `occupied`,
            clones_dir,
        } ) ).toThrow( `without matching Babysit metadata` )

    } )

    it( `rejects a source that contains the clone root before creating it`, () => {

        const nested_clone_root = join( source, `.babysit`, `clones` )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `recursive`,
            clones_dir: nested_clone_root,
        } ) ).toThrow( `cannot contain the clone root` )
        expect( existsSync( nested_clone_root ) ).toBe( false )

    } )

    it( `recognizes clone-root children whose names begin with two dots`, () => {

        const nested_clone_root = join( source, `..clones` )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `recursive-dot-prefix`,
            clones_dir: nested_clone_root,
        } ) ).toThrow( `cannot contain the clone root` )

    } )

    it( `rejects invalid clone ids before resolving a destination`, () => {

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `../escape`,
            clones_dir,
        } ) ).toThrow( `Clone id must contain only` )

    } )

    it( `fails clearly on FIFOs without leaving a clone or partial`, () => {

        const fifo = join( source, `events.fifo` )
        const result = spawnSync( `mkfifo`, [ fifo ] )
        expect( result.status ).toBe( 0 )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `special-file`,
            clones_dir,
        } ) ).toThrow( `unsupported FIFO` )
        expect( existsSync( join( clones_dir, `special-file` ) ) ).toBe( false )
        expect( readdirSync( join( clones_dir, `.babysit-state`, `partials` ) ) ).toEqual( [] )

    } )

} )

describe( `clone locks and stale partials`, () => {

    let directory
    let clones_dir
    let clone_path

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-state-test-` ) )
        clones_dir = join( directory, `clones` )
        clone_path = join( clones_dir, `locked` )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `excludes live owners and releases idempotently`, () => {

        const release = acquire_clone_lock( clone_path, { clones_dir } )

        expect( () => acquire_clone_lock( clone_path, { clones_dir } ) ).toThrow( `already locked` )
        expect( release() ).toBe( true )
        expect( release() ).toBe( true )

        const release_again = acquire_clone_lock( clone_path, { clones_dir } )
        expect( release_again() ).toBe( true )

    } )

    it( `recovers a lock whose same-host owner is dead`, () => {

        const old_release = acquire_clone_lock( clone_path, { clones_dir } )
        const next_release = acquire_clone_lock( clone_path, {
            clones_dir,
            is_process_alive: () => false,
        } )

        expect( old_release() ).toBe( false )
        expect( next_release() ).toBe( true )

    } )

    it( `sweeps stale owned partials and leaves unknown entries untouched`, () => {

        const release = acquire_clone_lock( clone_path, { clones_dir } )
        release()

        const partials = join( clones_dir, `.babysit-state`, `partials` )
        const owned_name = `abandoned.partial-test`
        const owned_path = join( partials, owned_name )
        const unknown_path = join( partials, `unknown.partial-test` )
        mkdirSync( owned_path )
        mkdirSync( unknown_path )
        writeFileSync( join( partials, `${ owned_name }.json` ), JSON.stringify( {
            magic: `babysit-clone`,
            version: 1,
            kind: `partial`,
            clone_id: `abandoned`,
            partial_name: owned_name,
            created_at_ms: 100,
        } ) )
        writeFileSync( join( partials, `unknown.partial-test.json` ), `{ "kind": "someone-else" }` )

        const removed = sweep_stale_clone_partials( {
            clones_dir,
            max_age_ms: 1_000,
            now: 2_000,
        } )

        expect( removed ).toEqual( [ owned_path ] )
        expect( existsSync( owned_path ) ).toBe( false )
        expect( existsSync( unknown_path ) ).toBe( true )
        expect( existsSync( join( partials, `unknown.partial-test.json` ) ) ).toBe( true )

    } )

} )

describe( `clone Git handling`, () => {

    let directory
    let source
    let clones_dir

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-git-test-` ) )
        source = join( directory, `source` )
        clones_dir = join( directory, `clones` )
        mkdirSync( source )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `creates a sanitized branch with hooks disabled and leaves source refs untouched`, () => {

        initialize_repository( source )
        const source_head = run_git( source, [ `rev-parse`, `HEAD` ] )
        const hook = join( source, `.git`, `hooks`, `post-checkout` )
        writeFileSync( hook, `#!/bin/sh\ntouch .hook-ran\n` )
        chmodSync( hook, 0o755 )

        const result = prepare_clone_workspace( {
            source,
            clone_id: `20260903-a1b2`,
            name: `Feature name!?`,
            clones_dir,
        } )

        expect( result.clone_branch ).toBe( `babysit/Feature-name-20260903-a1b2` )
        expect( result.git_repository ).toBe( true )
        expect( result.git_repository_kind ).toBe( `root` )
        expect( run_git( result.workspace, [ `branch`, `--show-current` ] ) ).toBe( result.clone_branch )
        expect( existsSync( join( result.workspace, `.hook-ran` ) ) ).toBe( false )
        expect( run_git( source, [ `branch`, `--show-current` ] ) ).toBe( `main` )
        expect( run_git( source, [ `rev-parse`, `HEAD` ] ) ).toBe( source_head )
        expect( run_git( source, [ `show-ref`, `--verify`, `refs/heads/${ result.clone_branch }` ], {
            allow_failure: true,
        } ) ).toBeNull()

    } )

    it( `switches an unborn repository to the clone branch`, () => {

        run_git( source, [ `init`, `-b`, `main` ] )

        const result = prepare_clone_workspace( {
            source,
            clone_id: `empty-repository`,
            name: `First branch`,
            clones_dir,
        } )

        expect( result.clone_branch ).toBe( `babysit/First-branch-empty-repository` )
        expect( run_git( result.workspace, [ `branch`, `--show-current` ] ) ).toBe( result.clone_branch )
        expect( run_git( source, [ `branch`, `--show-current` ] ) ).toBe( `main` )

    } )

    it( `turns arbitrary names into valid branch refs`, () => {

        expect( clone_branch_name( ` spaces / dots.. and @{} `, `clone.id` ) )
            .toBe( `babysit/spaces-dots-and-clone-id` )

    } )

    it( `rejects root Git pointer files used by linked worktrees`, () => {

        writeFileSync( join( source, `.git` ), `gitdir: /tmp/original/.git/worktrees/source\n` )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `linked-worktree`,
            clones_dir,
        } ) ).toThrow( `does not support Git worktrees or .git pointer files` )

    } )

    it( `rejects a root Git directory configured for an external worktree`, () => {

        initialize_repository( source )
        const external_worktree = join( directory, `external-worktree` )
        mkdirSync( external_worktree )
        run_git( source, [ `config`, `core.worktree`, external_worktree ] )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `external-worktree`,
            clones_dir,
        } ) ).toThrow( `configured for another worktree` )

    } )

    it( `rejects nested absolute Git pointers into external metadata`, () => {

        const nested = join( source, `nested` )
        mkdirSync( nested )
        writeFileSync( join( nested, `.git` ), `gitdir: ${ join( directory, `outside.git` ) }\n` )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `nested-pointer`,
            clones_dir,
        } ) ).toThrow( `unsafe absolute gitdir` )

    } )

    it( `rejects nested relative Git pointers that escape the copied source`, () => {

        const nested = join( source, `nested` )
        const external_git_dir = join( directory, `outside.git` )
        mkdirSync( nested )
        mkdirSync( external_git_dir )
        writeFileSync( join( nested, `.git` ), `gitdir: ../../outside.git\n` )

        expect( () => prepare_clone_workspace( {
            source,
            clone_id: `escaping-pointer`,
            clones_dir,
        } ) ).toThrow( `resolves outside the clone source` )

    } )

    it( `copies repository subdirectories as plain folders with warning metadata`, () => {

        const repository = join( directory, `repository` )
        const subdirectory = join( repository, `packages`, `app` )
        mkdirSync( subdirectory, { recursive: true } )
        initialize_repository( repository )
        writeFileSync( join( subdirectory, `app.js` ), `console.log('app')\n` )
        const warnings = []

        const result = prepare_clone_workspace( {
            source: subdirectory,
            clone_id: `subdirectory`,
            clones_dir,
            warn: message => warnings.push( message ),
        } )

        expect( result.git_repository ).toBe( false )
        expect( result.git_repository_kind ).toBe( `subdirectory` )
        expect( result.git_root ).toBe( repository )
        expect( result.clone_branch ).toBeNull()
        expect( warnings ).toEqual( [ expect.stringContaining( `cloning it as a plain folder` ) ] )
        expect( readFileSync( join( result.workspace, `app.js` ), `utf8` ) ).toBe( `console.log('app')\n` )
        expect( existsSync( join( result.workspace, `.git` ) ) ).toBe( false )

    } )

} )
