import { randomUUID } from 'crypto'
import {
    chmodSync,
    lstatSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs'
import { basename, isAbsolute, join, relative, sep } from 'path'

import {
    acquire_clone_lock,
    clone_state_paths,
    CLONE_STATE_MAGIC,
    CLONE_STATE_VERSION,
} from './clone.js'
import { CLONES_DIR } from './utils/paths.js'

const CLONE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/
const PRUNE_JOURNAL_KIND = `prune`

const path_entry = path => {

    try {
        return lstatSync( path )
    } catch ( error ) {
        if( error.code === `ENOENT` ) return null
        throw error
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

    const pending_path = `${ path }.pending-${ randomUUID() }`

    try {
        writeFileSync( pending_path, `${ JSON.stringify( value, null, 2 ) }\n`, {
            encoding: `utf8`,
            flag: `wx`,
            mode: 0o600,
        } )
        chmodSync( pending_path, 0o600 )
        renameSync( pending_path, path )
    } finally {
        rmSync( pending_path, { force: true } )
    }

}

const is_same_or_descendant = ( parent, candidate ) => {

    const child = relative( parent, candidate )
    return child === `` || child !== `..` && !child.startsWith( `..${ sep }` ) && !isAbsolute( child )

}

const managed_clone_from_manifest = ( manifest_path, clone_root ) => {

    const clone_id = basename( manifest_path, `.json` )
    if( !CLONE_ID_PATTERN.test( clone_id ) ) return null
    const manifest_entry = path_entry( manifest_path )
    if( !manifest_entry?.isFile() || manifest_entry.isSymbolicLink() ) return null

    const clone_path = join( clone_root, clone_id )
    const manifest = read_json( manifest_path )
    const valid_manifest = manifest?.magic === CLONE_STATE_MAGIC
        && manifest.version === CLONE_STATE_VERSION
        && manifest.status === `complete`
        && manifest.clone_id === clone_id
        && manifest.clone_path === clone_path
    if( !valid_manifest ) return null

    const entry = path_entry( clone_path )
    if( !entry?.isDirectory() || entry.isSymbolicLink() ) return null
    if( realpathSync( clone_path ) !== clone_path ) return null

    return {
        clone_id,
        clone_path,
        manifest_path,
        original_workspace: manifest.original_workspace || null,
        created_at: manifest.created_at || null,
        clone_branch: manifest.clone_branch || null,
    }

}

/**
 * List only complete clone workspaces backed by matching Babysit manifests.
 * Unknown root entries and malformed manifests are counted but never adopted.
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @returns {{ clones: Object[], ignored_entries: string[], invalid_manifests: string[], pending_prunes: string[] }}
 */
export const list_managed_clones = ( { clones_dir = CLONES_DIR } = {} ) => {

    const paths = clone_state_paths( clones_dir )
    const clone_root = realpathSync( paths.root )
    const manifest_files = readdirSync( paths.manifests )
        .filter( file => file.endsWith( `.json` ) )
    const invalid_manifests = []
    const clones = manifest_files.flatMap( file => {
        const manifest_path = join( paths.manifests, file )
        const clone = managed_clone_from_manifest( manifest_path, clone_root )

        if( clone ) return [ clone ]
        invalid_manifests.push( manifest_path )
        return []
    } )
    const managed_names = new Set( clones.map( ( { clone_id } ) => clone_id ) )
    const ignored_entries = readdirSync( clone_root, { withFileTypes: true } )
        .filter( entry => entry.name !== `.babysit-state` && !managed_names.has( entry.name ) )
        .map( entry => join( clone_root, entry.name ) )
    const pending_prunes = readdirSync( paths.prune_journals )
        .filter( file => file.endsWith( `.json` ) )
        .map( file => join( paths.prune_journals, file ) )

    return { clone_root, clones, ignored_entries, invalid_manifests, pending_prunes }

}

/**
 * Load and revalidate one managed clone by id.
 * @param {string} clone_id - Stable clone identifier
 * @param {Object} [options]
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @returns {Object|null} Managed clone metadata
 */
export const load_managed_clone = ( clone_id, { clones_dir = CLONES_DIR } = {} ) => {

    if( !CLONE_ID_PATTERN.test( clone_id || `` ) ) return null

    const paths = clone_state_paths( clones_dir )
    return managed_clone_from_manifest(
        join( paths.manifests, `${ clone_id }.json` ),
        realpathSync( paths.root )
    )

}

/**
 * Measure allocated bytes without following symlinks or crossing mount points.
 * Hard-linked files count once, matching the disk space a clone consumes.
 * @param {string} clone_path - Managed clone directory
 * @returns {number} Allocated bytes
 */
export const clone_directory_size = clone_path => {

    const root = realpathSync( clone_path )
    const root_entry = lstatSync( root )
    const root_device = root_entry.dev
    const pending = [ root ]
    const seen = new Set()
    let bytes = 0

    while( pending.length ) {
        const path = pending.pop()
        const entry = lstatSync( path )

        if( entry.dev !== root_device ) {
            const error = new Error( `Clone contains another mounted filesystem: ${ path }` )
            error.code = `BABYSIT_CLONE_CROSS_DEVICE`
            throw error
        }

        const inode = `${ entry.dev }:${ entry.ino }`
        const repeated_hardlink = !entry.isDirectory() && entry.nlink > 1 && seen.has( inode )
        if( repeated_hardlink ) continue
        if( entry.nlink > 1 ) seen.add( inode )

        bytes += Number.isFinite( entry.blocks ) ? entry.blocks * 512 : entry.size
        if( entry.isDirectory() ) {
            readdirSync( path ).forEach( name => pending.push( join( path, name ) ) )
        }
    }

    return bytes

}

/**
 * Test whether a path sits inside a managed clone.
 * @param {string} clone_path - Canonical clone root
 * @param {string} candidate - Candidate path
 * @returns {boolean} Whether candidate is the clone or one of its descendants
 */
export const path_is_inside_clone = ( clone_path, candidate ) =>
    is_same_or_descendant( realpathSync( clone_path ), realpathSync( candidate ) )

const make_tree_removable = path => {

    const entry = path_entry( path )
    if( !entry || entry.isSymbolicLink() ) return

    chmodSync( path, entry.mode | ( entry.isDirectory() ? 0o700 : 0o600 ) )
    if( entry.isDirectory() ) {
        readdirSync( path ).forEach( name => make_tree_removable( join( path, name ) ) )
    }

}

const remove_owned_tree = path => {

    try {
        rmSync( path, { recursive: true, force: true } )
    } catch ( error ) {
        if( ![ `EACCES`, `EPERM` ].includes( error.code ) ) throw error
        make_tree_removable( path )
        rmSync( path, { recursive: true, force: true } )
    }

}

const valid_prune_marker = ( marker, paths ) => {

    if( !marker || typeof marker !== `object` || Array.isArray( marker ) ) return false
    if( marker?.magic !== CLONE_STATE_MAGIC || marker.version !== CLONE_STATE_VERSION ) return false
    if( marker.kind !== PRUNE_JOURNAL_KIND || typeof marker.clone_id !== `string` ) return false
    if( !CLONE_ID_PATTERN.test( marker.clone_id ) || typeof marker.trash_name !== `string` ) return false
    if( basename( marker.trash_name ) !== marker.trash_name ) return false
    if( !CLONE_ID_PATTERN.test( marker.trash_name ) || !marker.trash_name.startsWith( `${ marker.clone_id }-` ) ) return false
    if( !Array.isArray( marker.session_ids ) ) return false
    if( !marker.session_ids.every( id => typeof id === `string` && CLONE_ID_PATTERN.test( id ) ) ) return false

    return marker.clone_path === join( paths.root, marker.clone_id )
        && marker.manifest_path === join( paths.manifests, `${ marker.clone_id }.json` )

}

const complete_prune = async ( marker, journal_path, paths, mark_sessions ) => {

    const trash_path = join( paths.trash, marker.trash_name )
    await mark_sessions( marker.session_ids, marker.pruned_at )
    if( path_entry( trash_path ) ) remove_owned_tree( trash_path )

    const manifest = read_json( marker.manifest_path )
    if( manifest && (
        manifest.magic !== CLONE_STATE_MAGIC
        || manifest.version !== CLONE_STATE_VERSION
        || manifest.clone_id !== marker.clone_id
        || manifest.clone_path !== marker.clone_path
    ) ) {
        throw new Error( `Prune manifest changed while finalizing ${ marker.clone_id }` )
    }

    rmSync( marker.manifest_path, { force: true } )
    rmSync( journal_path, { force: true } )

}

/**
 * Finish clone deletions that had already crossed the atomic quarantine point.
 * A journal with its source still present is pre-rename and is discarded.
 * @param {Object} options
 * @param {Function} options.mark_sessions - Idempotent session tombstone writer
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @returns {Promise<{ recovered: string[], failed: Array<{ path: string, error: Error }> }>} Recovery results
 */
export const recover_prune_operations = async ( {
    mark_sessions,
    clones_dir = CLONES_DIR,
} ) => {

    const paths = clone_state_paths( clones_dir )
    const recovered = []
    const failed = []

    for( const file of readdirSync( paths.prune_journals ).filter( name => name.endsWith( `.json` ) ) ) {
        const journal_path = join( paths.prune_journals, file )
        const journal_entry = path_entry( journal_path )
        if( !journal_entry?.isFile() || journal_entry.isSymbolicLink() ) {
            failed.push( { path: journal_path, error: new Error( `Invalid prune journal` ) } )
            continue
        }
        const marker = read_json( journal_path )

        if( !valid_prune_marker( marker, paths ) ) {
            failed.push( { path: journal_path, error: new Error( `Invalid prune journal` ) } )
            continue
        }

        const clone_exists = Boolean( path_entry( marker.clone_path ) )
        const trash_exists = Boolean( path_entry( join( paths.trash, marker.trash_name ) ) )

        try {
            if( clone_exists && !trash_exists ) {
                rmSync( journal_path, { force: true } )
                continue
            }
            if( clone_exists && trash_exists ) throw new Error( `Both clone and prune quarantine exist` )

            await complete_prune( marker, journal_path, paths, mark_sessions )
            recovered.push( marker.clone_id )
        } catch ( error ) {
            failed.push( { path: journal_path, error } )
        }
    }

    return { recovered, failed }

}

/**
 * Revalidate, atomically quarantine, and remove one managed clone.
 * @param {Object} options
 * @param {Object} options.clone - Inventory record to remove
 * @param {string[]} options.session_ids - Every stored launch in this clone family
 * @param {Function} options.revalidate - Async final activity/safety check
 * @param {Function} options.mark_sessions - Idempotent session tombstone writer
 * @param {string} [options.clones_dir] - Clone root, injectable for tests
 * @param {number} [options.now] - Epoch milliseconds for the prune timestamp
 * @returns {Promise<{ pruned: boolean, reason?: string, clone_id: string }>} Prune result
 */
export const prune_managed_clone = async ( {
    clone,
    session_ids,
    revalidate,
    mark_sessions,
    clones_dir = CLONES_DIR,
    now = Date.now(),
} ) => {

    const release_lock = acquire_clone_lock( clone.clone_path, { clones_dir } )

    try {
        const current = load_managed_clone( clone.clone_id, { clones_dir } )
        if( !current ) throw new Error( `Clone ownership changed before pruning: ${ clone.clone_id }` )

        const reason = await revalidate( current )
        if( reason ) return { pruned: false, reason, clone_id: clone.clone_id }

        const paths = clone_state_paths( clones_dir )
        const token = randomUUID()
        const trash_name = `${ clone.clone_id }-${ token }`
        const journal_path = join( paths.prune_journals, `${ clone.clone_id }-${ token }.json` )
        const marker = {
            magic: CLONE_STATE_MAGIC,
            version: CLONE_STATE_VERSION,
            kind: PRUNE_JOURNAL_KIND,
            clone_id: clone.clone_id,
            clone_path: clone.clone_path,
            manifest_path: current.manifest_path,
            trash_name,
            session_ids: [ ...new Set( session_ids ) ],
            pruned_at: new Date( now ).toISOString(),
        }
        let quarantined = false

        try {
            write_json_atomically( journal_path, marker )
            renameSync( current.clone_path, join( paths.trash, trash_name ) )
            quarantined = true
            await complete_prune( marker, journal_path, paths, mark_sessions )
        } catch ( error ) {
            if( !quarantined ) rmSync( journal_path, { force: true } )
            throw error
        }

        return { pruned: true, clone_id: clone.clone_id }
    } finally {
        release_lock()
    }

}
