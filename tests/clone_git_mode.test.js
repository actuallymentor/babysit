import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { clone_path_matcher, prepare_clone_workspace } from '../src/clone.js'
import { DEFAULT_CLONE_CONFIG, load_clone_config } from '../src/babysit/yaml.js'

const git = ( cwd, args ) => {
    const result = spawnSync( `git`, [ `-C`, cwd, `-c`, `user.name=t`, `-c`, `user.email=t@example.invalid`, ...args ], { encoding: `utf8` } )
    if( result.status !== 0 ) throw new Error( result.stderr )
    return result.stdout.trim()
}

// A repository with the usual clutter: ignored dependencies and build output,
// secrets, notes, an untracked scratch file, and uncommitted edits.
const make_repository = source => {
    mkdirSync( source, { recursive: true } )
    git( source, [ `init`, `-q`, `-b`, `main` ] )
    writeFileSync( join( source, `.gitignore` ), `node_modules\ndist\n.env*\n` )
    writeFileSync( join( source, `tracked.txt` ), `tracked\n` )
    mkdirSync( join( source, `web` ) )
    writeFileSync( join( source, `web`, `index.js` ), `web\n` )
    git( source, [ `add`, `.` ] )
    git( source, [ `commit`, `-q`, `-m`, `initial` ] )
    git( source, [ `remote`, `add`, `origin`, `https://example.invalid/repo.git` ] )
    for( const dir of [ `node_modules/pkg`, `web/node_modules/pkg`, `dist`, `.notes` ] ) mkdirSync( join( source, dir ), { recursive: true } )
    writeFileSync( join( source, `node_modules`, `pkg`, `index.js` ), `dep\n` )
    writeFileSync( join( source, `node_modules`, `pkg`, `.env` ), `dep secret\n` )
    writeFileSync( join( source, `web`, `node_modules`, `pkg`, `index.js` ), `dep\n` )
    writeFileSync( join( source, `dist`, `bundle.js` ), `built\n` )
    writeFileSync( join( source, `.env` ), `SECRET=1\n`, { mode: 0o600 } )
    writeFileSync( join( source, `web`, `.env.local` ), `WEB=1\n` )
    writeFileSync( join( source, `.notes`, `MEMORY.md` ), `notes\n` )
    writeFileSync( join( source, `scratch.txt` ), `scratch\n` )
    writeFileSync( join( source, `tracked.txt` ), `edited\n` )
}

describe( `clone path matcher`, () => {

    it( `matches names at any depth and anchored patterns beneath their directory`, () => {
        const match = clone_path_matcher( [ `node_modules`, `.env.*`, `/build`, `docs/**/*.md` ] )
        expect( match( `web/node_modules/pkg/index.js` ) ).toBe( true )
        expect( match( `web/.env.local` ) ).toBe( true )
        expect( match( `build/out.js` ) ).toBe( true )
        expect( match( `src/build/out.js` ) ).toBe( false )
        expect( match( `docs/a/b/readme.md` ) ).toBe( true )
        expect( match( `docs/readme.md` ) ).toBe( true )
        expect( match( `docs/readme.txt` ) ).toBe( false )
        expect( match( `.env` ) ).toBe( false )
        expect( clone_path_matcher( [ `**/.env` ] )( `.env` ) ).toBe( true )
    } )

} )

describe( `clone config`, () => {

    it( `falls back to defaults without creating babysit.yaml`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-clone-config-` ) )
        expect( load_clone_config( dir ) ).toEqual( DEFAULT_CLONE_CONFIG )
        expect( existsSync( join( dir, `babysit.yaml` ) ) ).toBe( false )
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `reads partial overrides and ignores invalid values`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-clone-config-` ) )
        writeFileSync( join( dir, `babysit.yaml` ), `config:\n    clone:\n        mode: copy\n        depth: 3\n        changes: true\n        carry: ['.env', 7]\n        exclude: ['node_modules', 'dist/*', '.cache']\n` )
        expect( load_clone_config( dir ) ).toEqual( { mode: `copy`, carry: [ `.env` ], changes: true, depth: 3, exclude: [ `node_modules`, `.cache` ] } )
        rmSync( dir, { recursive: true, force: true } )
    } )

} )

describe( `git clone mode`, () => {

    let directory
    let source
    let clones_dir
    let warnings

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-git-` ) )
        source = join( directory, `source` )
        clones_dir = join( directory, `clones` )
        warnings = []
        make_repository( source )
    } )

    afterEach( () => {
        rmSync( directory, { recursive: true, force: true } )
    } )

    const prepare = ( clone_config = {}, clone_id = `git-clone` ) => prepare_clone_workspace( {
        source, clones_dir, clone_id, name: `feature`, clone_config, warn: message => warnings.push( message ),
    } )

    it( `clones committed state, carries secrets and notes, skips dependencies and local edits`, () => {

        const object_counts = () => git( source, [ `count-objects`, `-v` ] ).split( `\n` ).filter( line => /^(count|in-pack):/.test( line ) )
        const objects_before = object_counts()
        const result = prepare()
        const clone = result.clone_path

        expect( result.clone_mode ).toBe( `git` )
        expect( result.clone_branch ).toBe( `babysit/feature-git-clone` )
        expect( git( clone, [ `branch`, `--show-current` ] ) ).toBe( `babysit/feature-git-clone` )
        expect( readFileSync( join( clone, `tracked.txt` ), `utf8` ) ).toBe( `tracked\n` )
        expect( readFileSync( join( clone, `.env` ), `utf8` ) ).toBe( `SECRET=1\n` )
        expect( lstatSync( join( clone, `.env` ) ).mode & 0o777 ).toBe( 0o600 )
        expect( readFileSync( join( clone, `web`, `.env.local` ), `utf8` ) ).toBe( `WEB=1\n` )
        expect( readFileSync( join( clone, `.notes`, `MEMORY.md` ), `utf8` ) ).toBe( `notes\n` )
        expect( existsSync( join( clone, `node_modules` ) ) ).toBe( false )
        expect( existsSync( join( clone, `web`, `node_modules` ) ) ).toBe( false )
        expect( existsSync( join( clone, `dist` ) ) ).toBe( false )
        expect( existsSync( join( clone, `scratch.txt` ) ) ).toBe( false )
        expect( git( clone, [ `remote`, `get-url`, `origin` ] ) ).toBe( `https://example.invalid/repo.git` )
        // Carried notes stay untracked, exactly as in the source; ignored secrets stay ignored.
        expect( git( clone, [ `status`, `--porcelain` ] ) ).toBe( `?? .notes/` )
        expect( warnings.join( `\n` ) ).toContain( `config.clone.changes: true` )

        // The source is untouched: still dirty, still on main, no stash entries, no new objects.
        expect( git( source, [ `status`, `--porcelain` ] ) ).toContain( `tracked.txt` )
        expect( git( source, [ `branch`, `--show-current` ] ) ).toBe( `main` )
        expect( git( source, [ `stash`, `list` ] ) ).toBe( `` )
        expect( object_counts() ).toEqual( objects_before )

    } )

    it( `keeps every local branch, the source's remote-tracking refs, and tags`, () => {

        git( source, [ `branch`, `feature-x` ] )
        git( source, [ `tag`, `v1` ] )
        git( source, [ `update-ref`, `refs/remotes/origin/main`, `HEAD` ] )

        const clone = prepare().clone_path

        expect( git( clone, [ `branch`, `--list`, `feature-x` ] ) ).toContain( `feature-x` )
        expect( git( clone, [ `tag`, `--list` ] ) ).toBe( `v1` )
        expect( git( clone, [ `rev-parse`, `--verify`, `refs/remotes/origin/main` ] ) ).toBe( git( source, [ `rev-parse`, `HEAD` ] ) )

    } )

    it( `carries whole untracked or ignored folders without walking dependencies`, () => {

        mkdirSync( join( source, `.cache`, `node_modules`, `dep` ), { recursive: true } )
        writeFileSync( join( source, `.cache`, `keep.txt` ), `k\n` )
        writeFileSync( join( source, `.cache`, `node_modules`, `dep`, `index.js` ), `d\n` )
        mkdirSync( join( source, `.notes`, `inner` ) )
        git( join( source, `.notes`, `inner` ), [ `init`, `-q` ] )
        writeFileSync( join( source, `.notes`, `inner`, `file.md` ), `i\n` )

        const clone = prepare( { carry: [ `.notes`, `.cache` ] } ).clone_path

        expect( readFileSync( join( clone, `.notes`, `MEMORY.md` ), `utf8` ) ).toBe( `notes\n` )
        expect( readFileSync( join( clone, `.cache`, `keep.txt` ), `utf8` ) ).toBe( `k\n` )
        expect( existsSync( join( clone, `.cache`, `node_modules` ) ) ).toBe( false )
        // A repository nested in a carried folder becomes a plain folder
        expect( existsSync( join( clone, `.notes`, `inner`, `file.md` ) ) ).toBe( true )
        expect( existsSync( join( clone, `.notes`, `inner`, `.git` ) ) ).toBe( false )

    } )

    it( `falls back to copying when attribute filters such as LFS are declared`, () => {
        writeFileSync( join( source, `.gitattributes` ), `*.bin filter=lfs diff=lfs merge=lfs -text\n` )
        const result = prepare()
        expect( result.clone_mode ).toBe( `copy` )
        expect( warnings.join( `\n` ) ).toContain( `attribute filters` )
    } )

    it( `carries staged and unstaged edits plus untracked files when changes is on`, () => {

        git( source, [ `add`, `tracked.txt` ] )
        writeFileSync( join( source, `web`, `index.js` ), `web edited\n` )

        const clone = prepare( { changes: true } ).clone_path
        const status = git( clone, [ `status`, `--porcelain` ] )

        expect( status ).toContain( `M  tracked.txt` )
        expect( status ).toContain( ` M web/index.js` )
        expect( status ).toContain( `?? scratch.txt` )
        expect( existsSync( join( clone, `node_modules` ) ) ).toBe( false )
        expect( warnings.join( `\n` ) ).not.toContain( `config.clone.changes` )

    } )

    it( `keeps a locally excluded secret ignored and never descends into nested repositories`, () => {

        writeFileSync( join( source, `.git`, `info`, `exclude` ), `local.secret\n` )
        writeFileSync( join( source, `local.secret` ), `s\n` )
        mkdirSync( join( source, `nested` ) )
        git( join( source, `nested` ), [ `init`, `-q` ] )
        writeFileSync( join( source, `nested`, `.env` ), `nested\n` )

        const clone = prepare( { carry: [ `local.secret`, `.env` ] } ).clone_path

        expect( readFileSync( join( clone, `local.secret` ), `utf8` ) ).toBe( `s\n` )
        expect( git( clone, [ `status`, `--porcelain` ] ) ).toBe( `` )
        expect( existsSync( join( clone, `nested` ) ) ).toBe( false )

    } )

    it( `never writes through a symlink the checkout restored`, () => {

        // Committed: .notes is a symlink elsewhere. Locally: a real directory with a note.
        const elsewhere = join( directory, `elsewhere` )
        mkdirSync( elsewhere )
        rmSync( join( source, `.notes` ), { recursive: true } )
        symlinkSync( elsewhere, join( source, `.notes` ) )
        git( source, [ `add`, `.notes` ] )
        git( source, [ `commit`, `-q`, `-m`, `link notes` ] )
        rmSync( join( source, `.notes` ) )
        mkdirSync( join( source, `.notes` ) )
        writeFileSync( join( source, `.notes`, `MEMORY.md` ), `local\n` )

        const clone = prepare().clone_path

        // Git reports the replaced symlink as a deletion and lists nothing beneath
        // it, so the clone keeps the committed link and the link target stays untouched.
        expect( lstatSync( join( clone, `.notes` ) ).isSymbolicLink() ).toBe( true )
        expect( existsSync( join( elsewhere, `MEMORY.md` ) ) ).toBe( false )

    } )

    it( `clones shallow history through the file transport when depth is set`, () => {

        writeFileSync( join( source, `tracked.txt` ), `second\n` )
        git( source, [ `commit`, `-q`, `-am`, `second` ] )

        const clone = prepare( { depth: 1 } ).clone_path

        expect( git( clone, [ `rev-list`, `--count`, `HEAD` ] ) ).toBe( `1` )
        expect( existsSync( join( clone, `.git`, `shallow` ) ) ).toBe( true )
        expect( readFileSync( join( clone, `.env` ), `utf8` ) ).toBe( `SECRET=1\n` )

    } )

    it( `rejects repositories that borrow objects through alternates`, () => {
        mkdirSync( join( source, `.git`, `objects`, `info` ), { recursive: true } )
        writeFileSync( join( source, `.git`, `objects`, `info`, `alternates` ), `/elsewhere/objects\n` )
        expect( () => prepare() ).toThrow( /alternates/ )
        expect( existsSync( join( clones_dir, `git-clone` ) ) ).toBe( false )
    } )

    it( `copies the working tree without excluded names when mode is copy`, () => {

        const result = prepare( { mode: `copy` } )
        const clone = result.clone_path

        expect( result.clone_mode ).toBe( `copy` )
        expect( readFileSync( join( clone, `tracked.txt` ), `utf8` ) ).toBe( `edited\n` )
        expect( existsSync( join( clone, `dist`, `bundle.js` ) ) ).toBe( true )
        expect( existsSync( join( clone, `scratch.txt` ) ) ).toBe( true )
        expect( existsSync( join( clone, `node_modules` ) ) ).toBe( false )
        expect( existsSync( join( clone, `web`, `node_modules` ) ) ).toBe( false )

    } )

    it( `falls back to copy mode for plain folders`, () => {
        const folder = join( directory, `folder` )
        mkdirSync( join( folder, `node_modules` ), { recursive: true } )
        writeFileSync( join( folder, `file.txt` ), `f\n` )
        const result = prepare_clone_workspace( { source: folder, clones_dir, clone_id: `folder-clone`, clone_config: { mode: `git` } } )
        expect( result.clone_mode ).toBe( `copy` )
        expect( existsSync( join( result.clone_path, `file.txt` ) ) ).toBe( true )
        expect( existsSync( join( result.clone_path, `node_modules` ) ) ).toBe( false )
    } )

} )
