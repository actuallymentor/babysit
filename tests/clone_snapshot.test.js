import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { prepare_clone_workspace } from '../src/clone.js'

const git = ( cwd, args, { allow_failure = false } = {} ) => {
    const result = spawnSync( `git`, [ `-C`, cwd, `-c`, `user.name=t`, `-c`, `user.email=t@example.invalid`, ...args ], { encoding: `utf8` } )
    if( result.status !== 0 && !allow_failure ) throw new Error( result.stderr )
    return result.stdout.trim()
}

// A repository on feat/x with a pushed base, one unpushed commit, an edit,
// a new file, and ignored clutter: everything a live agent leaves behind
const make_parent_tree = ( directory ) => {
    const remote = join( directory, `remote.git` )
    const source = join( directory, `source` )
    spawnSync( `git`, [ `init`, `-q`, `--bare`, remote ] )
    mkdirSync( source, { recursive: true } )
    git( source, [ `init`, `-q`, `-b`, `main` ] )
    writeFileSync( join( source, `.gitignore` ), `node_modules\n` )
    writeFileSync( join( source, `app.txt` ), `one\n` )
    git( source, [ `add`, `.` ] )
    git( source, [ `commit`, `-q`, `-m`, `base` ] )
    git( source, [ `remote`, `add`, `origin`, remote ] )
    git( source, [ `switch`, `-q`, `-c`, `feat/x` ] )
    git( source, [ `push`, `-q`, `-u`, `origin`, `feat/x` ] )
    writeFileSync( join( source, `app.txt` ), `one\ntwo\n` )
    git( source, [ `commit`, `-qam`, `unpushed` ] )
    writeFileSync( join( source, `app.txt` ), `one\ntwo\nedited\n` )
    writeFileSync( join( source, `new.txt` ), `untracked\n` )
    mkdirSync( join( source, `node_modules`, `pkg` ), { recursive: true } )
    writeFileSync( join( source, `node_modules`, `pkg`, `index.js` ), `dep\n` )
    return source
}

describe( `fork snapshot clones`, () => {

    let directory
    let source
    let clones_dir
    let warnings

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-fork-snapshot-` ) )
        clones_dir = join( directory, `clones` )
        warnings = []
        source = make_parent_tree( directory )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    const snapshot = ( options = {} ) => prepare_clone_workspace( {
        source,
        clone_id: `fork-1`,
        name: `parent-fork`,
        clones_dir,
        warn: message => warnings.push( message ),
        // Even an explicit `changes: false` is overridden by a snapshot
        clone_config: { mode: `git`, changes: false },
        snapshot: true,
        ...options,
    } )

    it( `carries edits, untracked files and unpushed commits onto a new branch from HEAD`, () => {

        const base = git( source, [ `rev-parse`, `HEAD` ] )
        const result = snapshot()

        expect( result.clone_mode ).toBe( `git` )
        expect( readFileSync( join( result.workspace, `app.txt` ), `utf8` ) ).toBe( `one\ntwo\nedited\n` )
        expect( readFileSync( join( result.workspace, `new.txt` ), `utf8` ) ).toBe( `untracked\n` )
        expect( existsSync( join( result.workspace, `node_modules` ) ) ).toBe( false )
        expect( git( result.workspace, [ `rev-parse`, `HEAD` ] ) ).toBe( base )
        expect( git( result.workspace, [ `symbolic-ref`, `--short`, `HEAD` ] ) ).toBe( result.clone_branch )
        expect( git( result.workspace, [ `log`, `--format=%s`, `-1` ] ) ).toBe( `unpushed` )
        // The parent's branch is still there, untouched, for reference
        expect( git( result.workspace, [ `rev-parse`, `feat/x` ] ) ).toBe( base )
        // The parent is only read
        expect( git( source, [ `status`, `--porcelain` ] ) ).toContain( `?? new.txt` )
        expect( git( source, [ `symbolic-ref`, `--short`, `HEAD` ] ) ).toBe( `feat/x` )

    } )

    it( `copies a tree mid-rebase, keeping the operation and only creating the branch`, () => {

        // Diverge main and conflict on app.txt, then stop the rebase on the conflict
        git( source, [ `stash`, `-u`, `-q` ] )
        git( source, [ `switch`, `-q`, `main` ] )
        writeFileSync( join( source, `app.txt` ), `main side\n` )
        git( source, [ `commit`, `-qam`, `main change` ] )
        git( source, [ `switch`, `-q`, `feat/x` ] )
        git( source, [ `stash`, `pop`, `-q` ] )
        git( source, [ `commit`, `-qam`, `wip` ] )
        git( source, [ `rebase`, `main` ], { allow_failure: true } )
        expect( existsSync( join( source, `.git`, `rebase-merge` ) ) || existsSync( join( source, `.git`, `rebase-apply` ) ) ).toBe( true )

        const result = snapshot()

        expect( result.clone_mode ).toBe( `copy` )
        expect( warnings.join( `\n` ) ).toContain( `merge or rebase is in progress` )
        expect( readFileSync( join( result.workspace, `app.txt` ), `utf8` ) ).toContain( `<<<<<<<` )
        expect( existsSync( join( result.workspace, `.git`, `rebase-merge` ) ) || existsSync( join( result.workspace, `.git`, `rebase-apply` ) ) ).toBe( true )
        expect( git( result.workspace, [ `branch`, `--list`, result.clone_branch ] ) ).toContain( result.clone_branch )
        expect( warnings.join( `\n` ) ).toContain( `created at HEAD without switching` )

    } )

    it( `falls back to copy mode when git stash create fails`, () => {

        // Unmerged index entries without merge state: only stash notices
        git( source, [ `commit`, `-qam`, `edits` ] )
        git( source, [ `switch`, `-q`, `-c`, `other`, `HEAD~1` ] )
        writeFileSync( join( source, `app.txt` ), `other side\n` )
        git( source, [ `commit`, `-qam`, `other` ] )
        git( source, [ `merge`, `feat/x` ], { allow_failure: true } )
        unlinkSync( join( source, `.git`, `MERGE_HEAD` ) )
        expect( spawnSync( `git`, [ `-C`, source, `stash`, `create` ] ).status ).not.toBe( 0 )

        const result = snapshot()

        expect( result.clone_mode ).toBe( `copy` )
        expect( warnings.join( `\n` ) ).toContain( `copying the working tree instead` )
        expect( readFileSync( join( result.workspace, `app.txt` ), `utf8` ) ).toContain( `<<<<<<<` )

    } )

    it( `snapshots a parent clone while recording the original workspace`, () => {

        const parent = prepare_clone_workspace( { source, clone_id: `parent`, clones_dir, warn: () => {}, clone_config: { mode: `git`, changes: true } } )
        writeFileSync( join( parent.workspace, `parent-only.txt` ), `from the parent clone\n` )

        const result = snapshot( { tree: parent.workspace } )

        expect( result.original_workspace ).toBe( source )
        expect( readFileSync( join( result.workspace, `parent-only.txt` ), `utf8` ) ).toContain( `parent clone` )
        expect( git( result.workspace, [ `rev-parse`, `HEAD` ] ) ).toBe( git( parent.workspace, [ `rev-parse`, `HEAD` ] ) )
        // The manifest stays keyed to the original, so a later resume reuses this clone
        expect( prepare_clone_workspace( { source, clone_id: `fork-1`, clones_dir } ).reused ).toBe( true )

    } )

    it( `still honours config.clone.changes for ordinary clones`, () => {

        const result = prepare_clone_workspace( { source, clone_id: `plain`, clones_dir, warn: message => warnings.push( message ), clone_config: { mode: `git`, changes: false } } )
        expect( readFileSync( join( result.workspace, `app.txt` ), `utf8` ) ).toBe( `one\ntwo\n` )
        expect( existsSync( join( result.workspace, `new.txt` ) ) ).toBe( false )

    } )

} )
