import { get_boot_id } from './sessions/lock.js'
import { spawnSync } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
    accessSync,
    chmodSync,
    constants,
    cpSync,
    linkSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs'
import { hostname } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'

import { log } from './utils/log.js'
import { CLONES_DIR } from './utils/paths.js'

const STATE_DIR_NAME = `.babysit-state`
export const CLONE_STATE_MAGIC = `babysit-clone`
export const CLONE_STATE_VERSION = 1
const DEFAULT_STALE_PARTIAL_MS = 24 * 60 * 60 * 1_000
const CLONE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

const path_exists = path => {

    try {
        lstatSync( path )
        return true
    } catch ( error ) {
        if( error.code === `ENOENT` ) return false
        throw error
    }

}

const path_entry = path => {

    try {
        return lstatSync( path )
    } catch ( error ) {
        if( error.code === `ENOENT` ) return null
        throw error
    }

}

const canonical_target_path = path => {

    const tail = []
    let existing = resolve( path )

    while( !path_exists( existing ) ) {
        const parent = dirname( existing )
        if( parent === existing ) throw new Error( `Could not resolve clone path: ${ path }` )

        tail.unshift( basename( existing ) )
        existing = parent
    }

    return join( realpathSync( existing ), ...tail )

}

const is_same_or_descendant = ( parent, candidate ) => {

    const child = relative( parent, candidate )
    return child === `` || child !== `..` && !child.startsWith( `..${ sep }` ) && !isAbsolute( child )

}

const ensure_private_directory = path => {

    const entry = path_entry( path )
    if( entry && ( entry.isSymbolicLink() || !entry.isDirectory() ) ) {
        throw new Error( `Clone state path is not a directory: ${ path }` )
    }

    mkdirSync( path, { recursive: true, mode: 0o700 } )
    chmodSync( path, 0o700 )

    return path

}

/**
 * Create and return the private external state directories for clone workspaces.
 * @param {string} clones_dir - Canonical clone root
 * @returns {Object} Clone root and private state paths
 */
export const clone_state_paths = clones_dir => {

    const root = ensure_private_directory( clones_dir )
    const state = ensure_private_directory( join( root, STATE_DIR_NAME ) )

    return {
        root,
        state,
        manifests: ensure_private_directory( join( state, `manifests` ) ),
        partials: ensure_private_directory( join( state, `partials` ) ),
        locks: ensure_private_directory( join( state, `locks` ) ),
        hooks: ensure_private_directory( join( state, `empty-hooks` ) ),
        trash: ensure_private_directory( join( state, `trash` ) ),
        prune_journals: ensure_private_directory( join( state, `prune-journals` ) ),
    }

}

const read_json = path => {

    try {
        return JSON.parse( readFileSync( path, `utf8` ) )
    } catch {
        return null
    }

}

const write_json_atomically = ( path, value ) => {

    const pending = `${ path }.pending-${ randomUUID() }`

    try {
        writeFileSync( pending, `${ JSON.stringify( value, null, 2 ) }\n`, {
            encoding: `utf8`,
            flag: `wx`,
            mode: 0o600,
        } )
        chmodSync( pending, 0o600 )
        renameSync( pending, path )
    } catch ( error ) {
        rmSync( pending, { force: true } )
        throw error
    }

}

const assert_clone_id = clone_id => {

    if( typeof clone_id !== `string` || !CLONE_ID_PATTERN.test( clone_id ) ) {
        throw new Error( `Clone id must contain only letters, numbers, dots, dashes, and underscores` )
    }

}

const lock_name_for = clone_path => {

    const hash = createHash( `sha256` ).update( resolve( clone_path ) ).digest( `hex` ).slice( 0, 24 )
    return `${ basename( clone_path ) }-${ hash }.lock`

}

const process_is_alive = pid => {

    if( !Number.isSafeInteger( pid ) || pid <= 0 ) return true

    try {
        process.kill( pid, 0 )
        return true
    } catch ( error ) {
        return error.code !== `ESRCH`
    }

}

const remove_dead_lock = ( lock_path, owner, is_process_alive ) => {

    if( owner?.magic !== CLONE_STATE_MAGIC || owner?.version !== CLONE_STATE_VERSION ) return false
    if( owner.hostname !== hostname() ) return false
    const previous_boot = owner.boot_id && get_boot_id() && owner.boot_id !== get_boot_id()
    if( !previous_boot && is_process_alive( owner.pid ) ) return false

    const quarantine = `${ lock_path }.stale-${ randomUUID() }`

    try {
        const current = read_json( lock_path )
        if( current?.token !== owner.token ) return false

        renameSync( lock_path, quarantine )
        rmSync( quarantine, { recursive: true, force: true } )
        return true
    } catch ( error ) {
        if( [ `ENOENT`, `EEXIST`, `ENOTEMPTY` ].includes( error.code ) ) return false
        throw error
    }

}

/**
 * Take an exclusive, crash-recoverable lock for one clone workspace.
 * The returned function releases only the lock created by this call.
 *
 * @param {string} clone_path - Final clone workspace path
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @param {Function} [options.is_process_alive] - Lock-owner liveness probe
 * @returns {Function} Idempotent release function
 */
export const acquire_clone_lock = ( clone_path, {
    clones_dir = dirname( resolve( clone_path ) ),
    is_process_alive = process_is_alive,
} = {} ) => {

    const clone_root = canonical_target_path( clones_dir )
    const target = canonical_target_path( clone_path )
    if( dirname( target ) !== clone_root ) {
        throw new Error( `Clone lock target must be a direct child of ${ clone_root }` )
    }

    const paths = clone_state_paths( clone_root )
    const lock_path = join( paths.locks, lock_name_for( target ) )
    const token = randomUUID()
    const owner = {
        magic: CLONE_STATE_MAGIC,
        version: CLONE_STATE_VERSION,
        token,
        pid: process.pid,
        hostname: hostname(),
        boot_id: get_boot_id(),
        clone_path: target,
        started_at: new Date().toISOString(),
    }

    const pending = join( paths.locks, `.pending-${ token }` )

    try {
        // A full disk may create a file but fail to write its owner. Publish
        // only a complete record; linking is exclusive and never replaces a lock.
        writeFileSync( pending, `${ JSON.stringify( owner, null, 2 ) }\n`, {
            encoding: `utf8`,
            flag: `wx`,
            mode: 0o600,
        } )

        for( let attempt = 0; attempt < 2; attempt++ ) {
            try {
                linkSync( pending, lock_path )
                break
            } catch ( error ) {
                if( error.code !== `EEXIST` ) throw error

                const current_owner = read_json( lock_path )
                if( attempt === 0 && remove_dead_lock( lock_path, current_owner, is_process_alive ) ) continue

                const lock_error = new Error( `Clone workspace is already locked: ${ target }` )
                lock_error.code = `BABYSIT_CLONE_LOCKED`
                throw lock_error
            }
        }
    } finally {
        // Cleanup must neither mask the storage error nor strand a published
        // lock by preventing its release callback from reaching the caller.
        try {
            rmSync( pending, { force: true } )
        } catch {
            // An unpublished pending record never blocks another acquisition.
        }
    }

    let released = false
    const release = () => {

        if( released ) return true

        const current_owner = read_json( lock_path )
        if( current_owner?.token !== token ) return false

        rmSync( lock_path, { force: true } )
        released = true
        return true

    }

    release.path = lock_path
    return release

}

/**
 * Inspect a clone launch lock without mutating it.
 * Same-host dead owners are reported as stale; final acquisition performs the
 * existing token-checked cleanup before destructive work begins.
 * @param {string} clone_path - Direct child of the clone root
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @param {Function} [options.is_process_alive] - Lock-owner liveness probe
 * @returns {'unlocked'|'locked'|'stale'|'unknown'} Lock state
 */
export const clone_lock_status = ( clone_path, {
    clones_dir = dirname( resolve( clone_path ) ),
    is_process_alive = process_is_alive,
} = {} ) => {

    const clone_root = canonical_target_path( clones_dir )
    const target = canonical_target_path( clone_path )
    if( dirname( target ) !== clone_root ) return `unknown`

    const paths = clone_state_paths( clone_root )
    const lock_path = join( paths.locks, lock_name_for( target ) )
    const entry = path_entry( lock_path )
    if( !entry ) return `unlocked`
    if( entry.isSymbolicLink() || !entry.isFile() ) return `unknown`

    const owner = read_json( lock_path )
    if( owner?.magic !== CLONE_STATE_MAGIC || owner?.version !== CLONE_STATE_VERSION ) return `unknown`
    if( owner.clone_path !== target || owner.hostname !== hostname() ) return `unknown`

    if( owner.boot_id && get_boot_id() && owner.boot_id !== get_boot_id() ) return `stale`
    return is_process_alive( owner.pid ) ? `locked` : `stale`

}

const clone_is_locked = ( clone_path, paths ) => path_exists(
    join( paths.locks, lock_name_for( clone_path ) )
)

/**
 * Remove abandoned clone partials only when their Babysit ownership sidecar is
 * valid and old enough. Unknown entries are left untouched.
 *
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root
 * @param {number} [options.max_age_ms] - Minimum partial age
 * @param {number} [options.now] - Current epoch milliseconds
 * @returns {string[]} Removed partial paths
 */
export const sweep_stale_clone_partials = ( {
    clones_dir = CLONES_DIR,
    max_age_ms = DEFAULT_STALE_PARTIAL_MS,
    now = Date.now(),
} = {} ) => {

    const paths = clone_state_paths( canonical_target_path( clones_dir ) )
    const removed = []

    for( const file of readdirSync( paths.partials ) ) {
        if( !file.endsWith( `.json` ) ) continue

        const sidecar_path = join( paths.partials, file )
        const sidecar_entry = path_entry( sidecar_path )
        if( !sidecar_entry?.isFile() || sidecar_entry.isSymbolicLink() ) continue

        const marker = read_json( sidecar_path )
        if( marker?.magic !== CLONE_STATE_MAGIC || marker?.version !== CLONE_STATE_VERSION ) continue
        if( marker.kind !== `partial` || basename( marker.partial_name || `` ) !== marker.partial_name ) continue
        if( !Number.isFinite( marker.created_at_ms ) || now - marker.created_at_ms < max_age_ms ) continue

        const partial_path = join( paths.partials, marker.partial_name )
        const partial_entry = path_entry( partial_path )
        if( partial_entry && ( partial_entry.isSymbolicLink() || !partial_entry.isDirectory() ) ) continue

        const clone_path = join( paths.root, marker.clone_id || `` )
        if( !CLONE_ID_PATTERN.test( marker.clone_id || `` ) || clone_is_locked( clone_path, paths ) ) continue

        if( partial_entry ) rmSync( partial_path, { recursive: true, force: true } )
        rmSync( sidecar_path, { force: true } )
        removed.push( partial_path )
    }

    return removed

}

const git_environment = () => {

    const env = { ...process.env }
    for( const key of [
        `GIT_DIR`,
        `GIT_WORK_TREE`,
        `GIT_COMMON_DIR`,
        `GIT_INDEX_FILE`,
        `GIT_OBJECT_DIRECTORY`,
        `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
    ] ) delete env[ key ]

    return env

}

const run_git = ( args, { allow_failure = false } = {} ) => {

    const result = spawnSync( `git`, args, {
        encoding: `utf8`,
        env: git_environment(),
        stdio: [ `ignore`, `pipe`, `pipe` ],
        timeout: 30_000,
    } )

    if( !result.error && result.status === 0 ) return String( result.stdout || `` ).trim()
    if( allow_failure ) return null

    const reason = result.error?.message || String( result.stderr || result.stdout || `` ).trim()
    throw new Error( `Git command failed: git ${ args.join( ` ` ) }${ reason ? ` (${ reason })` : `` }` )

}

const inspect_git_source = ( source, warn ) => {

    const dot_git = join( source, `.git` )
    const dot_git_entry = path_entry( dot_git )

    if( dot_git_entry && ( dot_git_entry.isSymbolicLink() || !dot_git_entry.isDirectory() ) ) {
        throw new Error( `Clone mode does not support Git worktrees or .git pointer files: ${ source }` )
    }

    const top_level = run_git( [ `-C`, source, `rev-parse`, `--show-toplevel` ], {
        allow_failure: !dot_git_entry,
    } )

    if( !top_level ) return { kind: `none`, root: null }

    const repository_root = realpathSync( top_level )
    if( repository_root !== source ) {
        if( dot_git_entry ) {
            throw new Error( `Clone mode does not support a root .git directory configured for another worktree: ${ source }` )
        }

        warn( `Source is inside Git repository ${ repository_root } but is not its root; cloning it as a plain folder.` )
        return { kind: `subdirectory`, root: repository_root }
    }

    if( !dot_git_entry ) {
        throw new Error( `Clone mode requires a standalone .git directory at the repository root: ${ source }` )
    }

    const git_dir = realpathSync( run_git( [ `-C`, source, `rev-parse`, `--absolute-git-dir` ] ) )
    const common_dir_value = run_git( [ `-C`, source, `rev-parse`, `--git-common-dir` ] )
    const common_dir_path = isAbsolute( common_dir_value )
        ? common_dir_value
        : resolve( source, common_dir_value )
    const common_dir = realpathSync( common_dir_path )

    if( !is_same_or_descendant( dot_git, git_dir ) || !is_same_or_descendant( dot_git, common_dir ) ) {
        throw new Error( `Clone mode does not support repositories with Git metadata outside ${ dot_git }` )
    }

    return { kind: `root`, root: repository_root }

}

// Resolve metadata before copying: an absolute path is safe only when its
// real target will be copied too. Symlinked metadata cannot be relocated safely.
const contained_git_path = ( source, path ) => {

    if( !is_same_or_descendant( source, path ) ) {
        throw new Error( `Nested Git metadata resolves outside the clone source: ${ path }` )
    }
    const target = realpathSync( path )
    if( target !== path || !is_same_or_descendant( source, target ) ) {
        throw new Error( `Nested Git metadata uses an unsafe symlink: ${ path }` )
    }
    return target

}

// Agents inside Babysit's container write /workspace paths into linked Git
// metadata. Translate only that known mount, never arbitrary foreign prefixes.
const source_git_path = ( source, base, pointer ) => {

    const path = resolve( base, pointer )
    if( is_same_or_descendant( source, path ) ) return path
    if( isAbsolute( pointer ) && is_same_or_descendant( `/workspace`, path ) ) {
        return join( source, relative( `/workspace`, path ) )
    }
    return path

}

const nested_git_pointer = ( path, source, require_relative = false ) => {

    const raw = readFileSync( path, `utf8` ).trim()
    const match = raw.match( /^gitdir:\s*(.+)$/i )
    if( !match ) throw new Error( `Invalid nested .git pointer: ${ path }` )

    const pointer = match[1].trim()
    if( require_relative && isAbsolute( pointer ) ) {
        throw new Error( `Clone source changed while copying; nested Git pointer is still absolute: ${ path }` )
    }
    return contained_git_path( source, source_git_path( source, dirname( path ), pointer ) )

}

const validate_git_worktree_config = ( source, git_dir ) => {

    // Submodule core.worktree is normally relative to its metadata. Keep
    // that supported layout, but reject overrides pointing elsewhere.
    for( const filename of [ `config`, `config.worktree` ] ) {
        const config = join( git_dir, filename )
        if( !path_exists( config ) ) continue
        contained_git_path( source, config )
        const worktree = run_git( [ `config`, `--file`, config, `--get`, `core.worktree` ], { allow_failure: true } )
        if( !worktree ) continue
        contained_git_path( source, resolve( git_dir, worktree ) )
        if( isAbsolute( worktree ) ) throw new Error( `Nested Git core.worktree must be relative: ${ config }` )
    }

}

// Prepare only metadata edits. Source files are never rewritten, and every
// write is checked again against the copied tree before it is applied.
const git_relocation_plan = ( source, git_entries ) => {

    const writes = new Map()
    const removals = []
    const git_dirs = new Set()
    const relative_link = ( file, target, prefix = `` ) => {
        writes.set( file, { content: `${ prefix }${ relative( dirname( file ), target ) }\n` } )
    }

    for( const path of git_entries ) {
        const git_dir = lstatSync( path ).isDirectory() ? path : nested_git_pointer( path, source )
        git_dirs.add( git_dir )
        if( path !== git_dir ) relative_link( path, git_dir, `gitdir: ` )

        const commondir = join( git_dir, `commondir` )
        if( path_exists( commondir ) ) {
            contained_git_path( source, commondir )
            const common = contained_git_path( source, source_git_path( source, git_dir, readFileSync( commondir, `utf8` ).trim() ) )
            git_dirs.add( common )
            relative_link( commondir, common )
        }

        validate_git_worktree_config( source, git_dir )
    }

    for( const git_dir of git_dirs ) {
        const worktrees = join( git_dir, `worktrees` )
        if( !path_exists( worktrees ) ) continue
        contained_git_path( source, worktrees )
        for( const name of readdirSync( worktrees ) ) {
            const registration = contained_git_path( source, join( worktrees, name ) )
            const backlink = join( registration, `gitdir` )
            if( !path_exists( backlink ) && !git_dirs.has( registration ) ) {
                removals.push( registration )
                continue
            }
            contained_git_path( source, backlink )
            const pointer = readFileSync( backlink, `utf8` ).trim()
            const target = source_git_path( source, registration, pointer )

            // Registrations for checkouts outside the copied tree belong only
            // to the original repository, including stale registrations.
            if( !is_same_or_descendant( source, target ) || !path_exists( target ) ) {
                if( git_dirs.has( registration ) ) {
                    throw new Error( `Nested Git worktree backlink resolves outside the clone source: ${ backlink }` )
                }
                removals.push( registration )
                continue
            }
            contained_git_path( source, target )
            if( nested_git_pointer( target, source ) !== registration ) {
                throw new Error( `Nested Git worktree backlink does not match its pointer: ${ backlink }` )
            }
            // Modern Git's already-relative backlinks survive both the
            // atomic rename and container mounts without a protective lock.
            if( !isAbsolute( pointer ) ) {
                relative_link( backlink, target )
                continue
            }
            writes.set( backlink, { target } )
            const locked = join( registration, `locked` )
            if( !path_exists( locked ) ) {
                // Old Git requires absolute backlinks. A container sees a
                // different mount path, so prevent prune deleting its metadata.
                writes.set( locked, { content: `Babysit clone may be mounted at a different path\n` } )
            }
        }
    }

    return { writes, removals }

}

const relocate_git_metadata = ( source, partial, destination, { writes, removals } ) => {

    const copied_path = path => join( partial, relative( source, path ) )
    for( const path of removals ) {
        rmSync( contained_git_path( partial, copied_path( path ) ), { recursive: true } )
    }
    for( const [ path, { content, target } ] of writes ) {
        const copied = copied_path( path )
        contained_git_path( partial, dirname( copied ) )
        if( path_exists( copied ) ) contained_git_path( partial, copied )
        writeFileSync( copied, target ? `${ join( destination, relative( source, target ) ) }\n` : content )
    }

}

// Owner permission bits the current user is missing to copy an entry.
// A directory needs read and search (x): `drw-------` lists its names, but
// every stat inside it fails with EACCES.
const missing_owner_bits = ( entry, directory ) => [
    entry.mode & 0o400 ? `` : `r`,
    directory && !( entry.mode & 0o100 ) ? `x` : ``,
].join( `` )

// Record why the current user cannot copy this entry, or null when it can.
const access_problem = ( path, entry ) => {

    const directory = entry.isDirectory()
    try {
        accessSync( path, directory ? constants.R_OK | constants.X_OK : constants.R_OK )
        return null
    } catch ( error ) {
        if( error.code !== `EACCES` ) throw error
    }

    const owned = typeof process.getuid === `function` && entry.uid === process.getuid()
    const bits = owned ? missing_owner_bits( entry, directory ) : ``
    return { path, directory, mode: entry.mode & 0o777, uid: entry.uid, dev: entry.dev, ino: entry.ino, bits }

}

// Unreadable entries are collected, not fatal, so one report covers them all.
const walk_source_tree = ( source, directory, blocked, git_entries ) => {

    for( const name of readdirSync( directory ) ) {
        const path = join( directory, name )
        const entry = lstatSync( path )

        if( entry.isSymbolicLink() ) {
            if( name === `.git` ) throw new Error( `Nested .git symlinks are not safe to clone: ${ path }` )
            continue
        }

        if( entry.isDirectory() ) {
            const problem = access_problem( path, entry )
            if( problem ) blocked.push( problem )
            else {
                if( name === `.git` ) git_entries.push( path )
                walk_source_tree( source, path, blocked, git_entries )
            }
            continue
        }

        if( entry.isFile() ) {
            const problem = access_problem( path, entry )
            if( problem ) blocked.push( problem )
            else if( name === `.git` && directory !== source ) git_entries.push( path )
            continue
        }

        const kind = entry.isSocket()
            ? `socket`
            : entry.isFIFO()
                ? `FIFO`
                : `special file`
        throw new Error( `Clone source contains an unsupported ${ kind }: ${ path }` )
    }

}

const audit_source_tree = source => {

    const problem = access_problem( source, lstatSync( source ) )
    const blocked = problem ? [ problem ] : []
    const git_entries = []
    if( !problem ) walk_source_tree( source, source, blocked, git_entries )
    if( !blocked.length ) return git_relocation_plan( source, git_entries )

    throw Object.assign( new Error( `Clone source has ${ blocked.length } path(s) the current user cannot read.` ), {
        code: `CLONE_SOURCE_UNREADABLE`,
        source,
        entries: blocked,
        fixable: blocked.every( item => item.bits ),
    } )

}

// The source may be live while cpSync runs. Recheck the finished snapshot so
// a newly created worktree cannot retain an unplanned link to source metadata.
const verify_copied_git_metadata = ( workspace, destination ) => {

    const git_entries = []
    const blocked = []
    walk_source_tree( workspace, workspace, blocked, git_entries )
    if( blocked.length ) throw new Error( `Clone source changed while copying; copied metadata cannot be fully checked` )
    const git_dirs = new Set()
    for( const path of git_entries ) {
        const git_dir = lstatSync( path ).isDirectory()
            ? path
            : nested_git_pointer( path, workspace, true )
        git_dirs.add( git_dir )
        validate_git_worktree_config( workspace, git_dir )
        const commondir = join( git_dir, `commondir` )
        if( !path_exists( commondir ) ) continue
        contained_git_path( workspace, commondir )
        const pointer = readFileSync( commondir, `utf8` ).trim()
        if( isAbsolute( pointer ) ) {
            throw new Error( `Clone source changed while copying; Git commondir is still absolute: ${ commondir }` )
        }
        const common = contained_git_path( workspace, resolve( git_dir, pointer ) )
        validate_git_worktree_config( workspace, common )
        git_dirs.add( common )
    }

    for( const git_dir of git_dirs ) {
        const worktrees = join( git_dir, `worktrees` )
        if( !path_exists( worktrees ) ) continue
        contained_git_path( workspace, worktrees )
        for( const name of readdirSync( worktrees ) ) {
            const registration = contained_git_path( workspace, join( worktrees, name ) )
            const backlink = contained_git_path( workspace, join( registration, `gitdir` ) )
            const pointer = readFileSync( backlink, `utf8` ).trim()
            if( isAbsolute( pointer ) && !is_same_or_descendant( destination, pointer ) ) {
                throw new Error( `Clone source changed while copying; Git backlink was not relocated: ${ backlink }` )
            }
            const target = isAbsolute( pointer )
                ? join( workspace, relative( destination, pointer ) )
                : resolve( registration, pointer )
            contained_git_path( workspace, target )
            if( nested_git_pointer( target, workspace, true ) !== registration ) {
                throw new Error( `Copied Git worktree backlink does not match its pointer: ${ backlink }` )
            }
        }
    }

}

/**
 * Grant the owner permission bits a CLONE_SOURCE_UNREADABLE audit reported.
 * Each path must still be the same inode and non-symlink it was when audited.
 * @param {Array<{ path: string, bits: string, dev: number, ino: number }>} entries - Audited entries
 * @returns {number} Paths changed
 */
export const grant_clone_source_access = entries => {

    let changed = 0
    for( const { path, bits, dev, ino } of entries ) {
        if( !bits ) throw new Error( `No owner permission fix applies to ${ path }` )
        const current = lstatSync( path )
        if( current.isSymbolicLink() || current.dev !== dev || current.ino !== ino || current.uid !== process.getuid?.() ) {
            throw new Error( `Clone source changed since it was checked: ${ path }` )
        }
        const add = ( bits.includes( `r` ) ? 0o400 : 0 ) | ( bits.includes( `x` ) ? 0o100 : 0 )
        chmodSync( path, current.mode & 0o7777 | add )
        changed++
    }
    return changed

}

/**
 * Turn a display name and clone id into a portable Git branch name.
 * @param {string|false|null} name - Optional session display name
 * @param {string} clone_id - Babysit clone id
 * @returns {string} Validated `babysit/...` branch name
 */
export const clone_branch_name = ( name, clone_id ) => {

    assert_clone_id( clone_id )

    const slug = value => String( value || `` )
        .normalize( `NFKD` )
        .replace( /[^a-zA-Z0-9_]+/g, `-` )
        .replace( /^-+|-+$/g, `` )

    const name_segment = slug( name ).slice( 0, 80 )
    const id_segment = slug( clone_id )
    const branch = `babysit/${ name_segment ? `${ name_segment }-` : `` }${ id_segment }`

    run_git( [ `check-ref-format`, `--branch`, branch ] )
    return branch

}

const create_clone_branch = ( workspace, branch, hooks_path ) => {

    const git_prefix = [ `-c`, `core.hooksPath=${ hooks_path }`, `-C`, workspace ]
    const has_head = run_git( [ ...git_prefix, `rev-parse`, `--verify`, `HEAD` ], {
        allow_failure: true,
    } ) !== null

    if( has_head ) run_git( [ ...git_prefix, `switch`, `-c`, branch ] )
    else run_git( [ ...git_prefix, `symbolic-ref`, `HEAD`, `refs/heads/${ branch }` ] )

}

const copy_directory_contents = ( source, destination ) => {

    mkdirSync( destination, { mode: 0o700 } )
    const entries = readdirSync( source )

    if( process.platform === `linux` ) {
        // One transfer keeps hard links across top-level entries. Listing
        // contents with no implied dirs leaves the private root's attributes alone.
        const result = spawnSync( `rsync`, [
            `-aHAXS`, `--recursive`, `--no-implied-dirs`, `--from0`, `--files-from=-`, `--`,
            `${ source }/`, `${ destination }/`,
        ], {
            // Even --from0 treats leading # and ; as comments in files-from.
            input: entries.map( entry => `./${ entry }\0` ).join( `` ),
            encoding: `utf8`,
            stdio: [ `pipe`, `pipe`, `pipe` ],
        } )
        if( result.error?.code === `ENOENT` ) {
            throw new Error( `Linux clone creation requires rsync. Install it with your package manager (for example: sudo apt install rsync) and retry.` )
        }
        if( result.error || result.signal || result.status !== 0 ) {
            const reason = result.error?.message || result.signal || `exit ${ result.status }`
            const detail = String( result.stderr || `` ).trim()
            throw new Error( `Clone copy failed: rsync ${ reason }${ detail ? ` (${ detail })` : `` }` )
        }
        return
    }

    for( const entry of entries ) {
        cpSync( join( source, entry ), join( destination, entry ), {
            recursive: true,
            dereference: false,
            errorOnExist: true,
            force: false,
            preserveTimestamps: true,
            verbatimSymlinks: true,
        } )
    }

}

const result_from_manifest = ( manifest, reused ) => ( {
    original_workspace: manifest.original_workspace,
    workspace: manifest.clone_path,
    clone_path: manifest.clone_path,
    clone_id: manifest.clone_id,
    clone_branch: manifest.clone_branch,
    git_repository: manifest.git_repository,
    git_repository_kind: manifest.git_repository_kind,
    git_root: manifest.git_root,
    reused,
} )

const completed_clone = ( clone_path, manifest_path, { source, clone_id } ) => {

    const entry = path_entry( clone_path )
    if( !entry ) return null
    if( entry.isSymbolicLink() || !entry.isDirectory() ) {
        throw new Error( `Existing clone path is not a directory: ${ clone_path }` )
    }

    const manifest = read_json( manifest_path )
    const valid = manifest?.magic === CLONE_STATE_MAGIC
        && manifest.version === CLONE_STATE_VERSION
        && manifest.status === `complete`
        && manifest.clone_id === clone_id
        && manifest.original_workspace === source
        && manifest.clone_path === clone_path

    if( !valid ) {
        throw new Error( `Refusing to reuse clone without matching Babysit metadata: ${ clone_path }` )
    }

    if( realpathSync( clone_path ) !== clone_path ) {
        throw new Error( `Refusing to reuse clone through a redirected path: ${ clone_path }` )
    }

    return result_from_manifest( manifest, true )

}

/**
 * Prepare an isolated clone workspace with an atomic first-copy boundary.
 * Existing clones are reused only when their external Babysit manifest matches.
 *
 * @param {Object} options
 * @param {string} options.source - Directory to copy
 * @param {string} options.clone_id - Stable clone identifier
 * @param {string|false|null} [options.name] - Optional session display name
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @param {Function} [options.warn] - Warning sink
 * @param {number} [options.now] - Current epoch milliseconds
 * @param {number} [options.stale_partial_ms] - Partial cleanup threshold
 * @returns {Object} Original/clone paths, Git metadata, and reuse state
 */
export const prepare_clone_workspace = ( {
    source,
    clone_id,
    name = null,
    clones_dir = CLONES_DIR,
    warn = message => log.warn( message ),
    now = Date.now(),
    stale_partial_ms = DEFAULT_STALE_PARTIAL_MS,
} ) => {

    assert_clone_id( clone_id )

    const original_workspace = realpathSync( resolve( source ) )
    if( !lstatSync( original_workspace ).isDirectory() ) {
        throw new Error( `Clone source is not a directory: ${ original_workspace }` )
    }

    const clone_root = canonical_target_path( clones_dir )
    if( is_same_or_descendant( original_workspace, clone_root ) ) {
        throw new Error( `Clone source cannot contain the clone root: ${ clone_root }` )
    }

    const paths = clone_state_paths( clone_root )
    sweep_stale_clone_partials( {
        clones_dir: clone_root,
        max_age_ms: stale_partial_ms,
        now,
    } )

    const clone_path = join( clone_root, clone_id )
    const manifest_path = join( paths.manifests, `${ clone_id }.json` )
    const release_lock = acquire_clone_lock( clone_path, { clones_dir: clone_root } )

    try {
        const existing = completed_clone( clone_path, manifest_path, {
            source: original_workspace,
            clone_id,
        } )
        if( existing ) return existing

        const repository = inspect_git_source( original_workspace, warn )
        const git_relocations = audit_source_tree( original_workspace )
        const clone_branch = repository.kind === `root`
            ? clone_branch_name( name, clone_id )
            : null
        const partial_name = `${ clone_id }.partial-${ randomUUID() }`
        const partial_path = join( paths.partials, partial_name )
        const sidecar_path = join( paths.partials, `${ partial_name }.json` )
        const partial_marker = {
            magic: CLONE_STATE_MAGIC,
            version: CLONE_STATE_VERSION,
            kind: `partial`,
            clone_id,
            partial_name,
            original_workspace,
            created_at_ms: now,
        }

        write_json_atomically( sidecar_path, partial_marker )

        try {
            copy_directory_contents( original_workspace, partial_path )
            relocate_git_metadata( original_workspace, partial_path, clone_path, git_relocations )
            verify_copied_git_metadata( partial_path, clone_path )
            if( clone_branch ) create_clone_branch( partial_path, clone_branch, paths.hooks )

            if( path_exists( clone_path ) ) {
                throw new Error( `Clone path appeared while preparing the workspace: ${ clone_path }` )
            }

            const manifest = {
                magic: CLONE_STATE_MAGIC,
                version: CLONE_STATE_VERSION,
                status: `complete`,
                clone_id,
                clone_path,
                original_workspace,
                clone_branch,
                git_repository: repository.kind === `root`,
                git_repository_kind: repository.kind,
                git_root: repository.root,
                created_at: new Date( now ).toISOString(),
            }

            // The lock prevents readers until rename completes. Writing the
            // manifest first closes the power-loss gap between rename and state.
            write_json_atomically( manifest_path, manifest )
            renameSync( partial_path, clone_path )
            rmSync( sidecar_path, { force: true } )

            return result_from_manifest( manifest, false )
        } catch ( error ) {
            rmSync( partial_path, { recursive: true, force: true } )
            rmSync( sidecar_path, { force: true } )

            const manifest = read_json( manifest_path )
            if( manifest?.clone_id === clone_id && !path_exists( clone_path ) ) {
                rmSync( manifest_path, { force: true } )
            }

            throw error
        }
    } finally {
        release_lock()
    }

}
