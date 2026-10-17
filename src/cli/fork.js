import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { createInterface } from 'readline/promises'

import { log } from '../utils/log.js'
import { BABYSIT_DIR, CLONES_DIR } from '../utils/paths.js'
import { run } from '../utils/exec.js'
import { get_agent } from '../agents/index.js'
import { docker_command_prefix, get_agent_state_mounts } from '../docker/run.js'
import { get_image_name } from '../docker/update.js'
import { attach_session, list_sessions } from '../tmux/session.js'
import { list_stored_sessions, session_original_workspace, session_workspace } from '../sessions/store.js'
import { build_handoff_markdown, read_parent_transcript } from '../sessions/handoff.js'
import { replayable_options } from '../sessions/recovery.js'
import { load_managed_clone } from '../prune.js'
import { fork_parent_of, order_active_sessions, stored_by_tmux } from './list.js'
import { FORK_NEGATABLE_FLAGS } from './parse.js'
import { merge_resume_flags } from './resume.js'
import { cmd_start } from './start.js'
import { close_session } from './recover.js'

// Container paths the fork reads its handoff and the parent's raw transcript from
export const HANDOFF_CONTAINER_PATH = `/tmp/babysit-fork-handoff.md`
const TRANSCRIPT_CONTAINER_PREFIX = `/tmp/babysit-fork-transcript-`

/**
 * Resolve `babysit fork <selector>` to a stored parent record. Numbers are
 * `babysit list` rows, exited fork parents included; IDs and native IDs
 * reach any stored launch, followed to that conversation's current launch.
 * @param {string} selector - List number, babysit id, native id, or unique live name
 * @param {Array<{ name: string, exited?: boolean }>} ordered - order_active_sessions output
 * @param {Object[]} stored - Stored session records, newest first
 * @returns {{ parent: Object, number: number|null }} Parent record and its list number
 */
export const select_fork_parent = ( selector, ordered, stored ) => {

    const by_tmux = stored_by_tmux( stored )
    const stored_for = row => by_tmux.get( row.name )
    const number_of = session => {
        const index = ordered.findIndex( row => row.name === session.tmux_session )
        return index === -1 ? null : index + 1
    }

    if( !selector ) throw new Error( `Usage: babysit fork <number|session_id> [agent] [flags]` )

    if( /^\d+$/.test( selector ) ) {
        const row = ordered[ Number( selector ) - 1 ]
        if( !row ) throw new Error( `No session numbered ${ selector }. Run babysit list to see session numbers.` )
        const parent = stored_for( row )
        if( !parent ) throw new Error( `No stored session found for session numbered ${ selector } (${ row.name }).` )
        return { parent, number: Number( selector ) }
    }

    // A resumed conversation keeps its old ids; fork the launch that holds it now
    const by_id = new Map( stored.map( session => [ session.babysit_id, session ] ) )
    const match = stored.find( session => session.babysit_id === selector || session.agent_session_id === selector )
    if( match ) {
        const parent = fork_parent_of( { forked_from: match.babysit_id }, by_id ) || match
        return { parent, number: number_of( parent ) }
    }

    const named = ordered.map( stored_for ).filter( session => session?.name === selector )
    if( named.length > 1 ) throw new Error( `Several sessions are named "${ selector }"; use a list number or id.` )
    if( named.length === 1 ) return { parent: named[0], number: number_of( named[0] ) }

    throw new Error( `No session matches ${ selector }. Run babysit list to see session numbers.` )

}

/**
 * Name for a fork: forks of forks do not stack (`x-fork-fork`), they count
 * up instead (`x-fork-2`), skipping names already in use.
 * @param {string|null} name - Parent name
 * @param {string[]} [taken=[]] - Names already in use
 * @returns {string|false} Fork name, or false for an unnamed parent
 */
export const fork_name = ( name, taken = [] ) => {

    if( !name ) return false

    const base = name.replace( /-fork(-\d+)?$/, `` )
    const used = new Set( [ name, ...taken ] )
    let number = 1
    const candidate = () => number === 1 ? `${ base }-fork` : `${ base }-fork-${ number }`
    while( used.has( candidate() ) ) number++

    return candidate()

}

/**
 * Start from the parent's launch flags, then apply what the user typed.
 * Clone and ports are never inherited: the filesystem is chosen per fork,
 * and a live parent still holds its published ports.
 * @param {Object} parent - Parent session record
 * @param {Object} flags - Parsed fork flags (see parse.js)
 * @param {string[]} [taken=[]] - Session names already in use
 * @returns {Object} Flags for cmd_start, clone still undecided
 */
export const merge_fork_flags = ( parent, flags = {}, taken = [] ) => {

    const inherited = merge_resume_flags( parent.modifiers, {}, parent )
    const unset = new Set( flags.unset || [] )
    const switches = Object.fromEntries( FORK_NEGATABLE_FLAGS.map( flag => [
        flag,
        unset.has( flag ) ? false : Boolean( flags[ flag ] || inherited[ flag ] ),
    ] ) )

    // One mode at a time: an explicit mode replaces the inherited one. A typed
    // filesystem needs a writable workspace, so on its own it means regular.
    const typed_mode = flags.regular ? `regular` : flags.sandbox ? `sandbox` : flags.mudbox ? `mudbox` : null
    const explicit_mode = typed_mode || ( flags.share || flags.clone ? `regular` : null )
    const mode = explicit_mode || ( inherited.sandbox ? `sandbox` : inherited.mudbox ? `mudbox` : `regular` )

    return {
        ...flags,
        ...switches,
        sandbox: mode === `sandbox`,
        mudbox: mode === `mudbox`,
        // Only a typed --clone counts; the parent's clone mode is not inherited
        clone: Boolean( flags.clone ),
        // Isolation from the host profile is sticky, like on resume
        ignore_host_agents_md: Boolean( flags.ignore_host_agents_md || inherited.ignore_host_agents_md ),
        name: flags.name || fork_name( parent.name, taken ),
        config: flags.config || parent.config_path || false,
        ports: flags.ports || [],
    }

}

/**
 * Agent CLI arguments for the fork. The parent's saved model/effort only
 * apply to the same agent; an explicitly passed option replaces its value.
 * @param {Object} parent - Parent session record
 * @param {string} agent_name - Fork agent
 * @param {string[]} passthrough - Agent arguments typed on the fork command
 * @returns {string[]} Agent arguments
 */
export const merge_fork_passthrough = ( parent, agent_name, passthrough = [] ) => {

    if( parent.agent !== agent_name ) return passthrough

    // Compare canonical names, so a typed `-m` replaces a saved `--model`
    const options = replayable_options( { name: agent_name } )
    const canonical = argument => options.get( argument.split( `=` )[0] )
    const saved = parent.launch_spec?.args || []
    const typed = new Set( passthrough.map( canonical ).filter( Boolean ) )
    const kept = saved.flatMap( ( argument, index ) => {
        if( index % 2 ) return []
        return typed.has( canonical( argument ) ) ? [] : [ argument, saved[ index + 1 ] ]
    } )

    return [ ...kept, ...passthrough ]

}

/**
 * The filesystem a fork gets when the user does not choose: an exited or
 * stuck parent hands over its workspace, a live one keeps it to itself.
 * @param {Object} options
 * @param {boolean} options.parent_live - Parent tmux session exists
 * @param {boolean} options.parent_stuck - Parent asked for help (babysit stuck)
 * @param {Object} options.flags - Merged fork flags
 * @returns {'share'|'clone'|'none'} Default filesystem
 */
export const default_fork_filesystem = ( { parent_live, parent_stuck, flags } ) => {

    if( flags.sandbox ) return `none`
    if( flags.mudbox ) return `share`

    return parent_live && !parent_stuck ? `clone` : `share`

}

// Read-only Git query; null on any failure so callers treat it as "unknown"
const git = ( tree, args ) => {

    const result = spawnSync( `git`, [ `-C`, tree, `--no-optional-locks`, ...args ], { encoding: `utf8`, stdio: [ `ignore`, `pipe`, `ignore` ], timeout: 15_000 } )
    return result.status === 0 ? String( result.stdout ).trimEnd() : null

}

/**
 * Read the parent tree's Git state without touching it (no index refresh).
 * @param {string|null} tree - Parent workspace on the host
 * @returns {Object} { git, branch, base, modified, untracked, unpushed, status, diff_stat, unpushed_log }
 */
export const describe_parent_tree = tree => {

    if( !tree || !existsSync( tree ) || git( tree, [ `rev-parse`, `--is-inside-work-tree` ] ) !== `true` ) return { git: false }

    const status = git( tree, [ `status`, `--porcelain` ] ) || ``
    const entries = status.split( `\n` ).filter( Boolean )
    const unpushed_log = git( tree, [ `log`, `--oneline`, `@{upstream}..HEAD` ] )

    return {
        git: true,
        branch: git( tree, [ `symbolic-ref`, `--short`, `-q`, `HEAD` ] ) || null,
        base: git( tree, [ `rev-parse`, `--verify`, `-q`, `HEAD` ] ) || null,
        modified: entries.filter( line => !line.startsWith( `??` ) ).length,
        untracked: entries.filter( line => line.startsWith( `??` ) ).length,
        // No upstream means nothing can be "unpushed" relative to it
        unpushed: unpushed_log === null ? null : unpushed_log.split( `\n` ).filter( Boolean ).length,
        status,
        diff_stat: git( tree, [ `diff`, `--stat`, `HEAD` ] ) || ``,
        unpushed_log: unpushed_log || ``,
    }

}

/**
 * One-line parent summary shown above the filesystem choice, e.g.
 * `feat/x · 3 modified · 2 untracked · 1 unpushed · parent: live`.
 * @param {Object} tree - describe_parent_tree result
 * @param {string} parent_state - live, stuck, or exited
 * @returns {string} State line
 */
export const format_parent_state = ( tree, parent_state ) => [
    tree.git ? tree.branch || `detached ${ tree.base?.slice( 0, 7 ) || `HEAD` }` : `no git`,
    ... tree.git ? [ `${ tree.modified } modified`, `${ tree.untracked } untracked` ] : [],
    ... tree.git && tree.unpushed !== null ? [ `${ tree.unpushed } unpushed` ] : [],
    `parent: ${ parent_state }`,
].join( ` · ` )

// One terminal question; the readline closes again so stdin stays free for tmux
const ask_line = async question => {

    const rl = createInterface( { input: process.stdin, output: process.stdout } )
    try {
        return await rl.question( question )
    } finally {
        rl.close()
    }

}

/**
 * Decide the fork's filesystem: flags first, then the default when the user
 * pre-agreed (--yes, YOLO), otherwise ask. Non-interactive stdin must say.
 * @param {Object} options
 * @param {Object} options.flags - Merged fork flags
 * @param {string} options.fallback - default_fork_filesystem result
 * @param {boolean} options.assume_default - Take the default without asking
 * @param {Function} [options.ask] - Question seam, resolves to the typed answer
 * @param {NodeJS.ReadableStream} [options.input=process.stdin] - Prompt input
 * @returns {Promise<'share'|'clone'|'none'>} Filesystem choice
 */
export const choose_fork_filesystem = async ( {
    flags,
    fallback,
    assume_default,
    ask = null,
    input = process.stdin,
} ) => {

    // parse.js already refuses --share with --clone, and --clone with a mudbox.
    // Sandbox has no workspace; mudbox only reads, so a copy would protect nothing.
    if( flags.sandbox ) return `none`
    if( flags.mudbox ) return `share`

    if( flags.share ) return `share`
    if( flags.clone ) return `clone`
    if( assume_default ) return fallback

    if( !ask && !input.isTTY ) {
        throw new Error( `babysit fork needs --share or --clone on non-interactive stdin (or --yes for the default: ${ fallback })` )
    }

    const question = fallback === `clone`
        ? `Filesystem: [c]lone a snapshot or [s]hare the parent's workspace? [C/s] `
        : `Filesystem: [s]hare the parent's workspace or [c]lone a snapshot? [S/c] `
    const ask_user = ask || ask_line
    const answer = ( await ask_user( question ) ).trim().toLowerCase()
    if( !answer ) return fallback
    if( [ `c`, `clone` ].includes( answer ) ) return `clone`
    if( [ `s`, `share` ].includes( answer ) ) return `share`

    throw new Error( `Unknown filesystem choice: ${ answer }` )

}

/**
 * How the fork learns what its parent did: the agent's own fork when the
 * agent stays the same and its state is reachable, else a babysit handoff.
 * @param {Object} options
 * @param {Object} options.parent - Parent session record
 * @param {Object} options.agent - Fork agent adapter
 * @param {Object} options.flags - Merged fork flags
 * @returns {{ kind: 'native'|'handoff'|'none', reason: string }} History plan
 */
export const plan_fork_history = ( { parent, agent, flags } ) => {

    if( flags.history === false ) return { kind: `none`, reason: `--no-history` }
    if( parent.modifiers?.includes( `sandbox` ) ) return { kind: `handoff`, reason: `sandbox conversations are not saved in volumes` }
    if( parent.agent !== agent.name ) return { kind: `handoff`, reason: `${ parent.agent } → ${ agent.name }` }
    if( !agent.flags.fork ) return { kind: `handoff`, reason: `${ agent.name } has no CLI fork` }
    if( flags.sandbox ) return { kind: `handoff`, reason: `a sandbox fork has no conversation volumes` }
    if( !parent.agent_session_id ) return { kind: `handoff`, reason: `the parent's native session id was never captured` }

    return { kind: `native`, reason: `${ agent.name } native fork` }

}

// Marker the copy script prints when a SQLite database was copied file by file
const RAW_SQLITE_COPY = `babysit-raw-sqlite-copy`

/**
 * Copy one state volume into another. Files are copied as they are, then every
 * SQLite database is redone with `.backup`: a raw copy of a database (and its
 * -wal) that the parent is writing can be torn. `.backup` takes SQLite's own
 * locks, so the source is mounted writable for its -shm, and opened -readonly
 * so nothing in it changes. Images without sqlite3 keep the raw copy with its
 * -wal/-shm and print RAW_SQLITE_COPY.
 */
export const COPY_STATE_SCRIPT = `
cp -a /from/. /to/ || exit 1
find /from -type f ! -name '*-wal' ! -name '*-shm' ! -name '*-journal' | while IFS= read -r db; do
    [ "$(head -c 15 "$db" 2>/dev/null)" = "SQLite format 3" ] || continue
    command -v sqlite3 >/dev/null 2>&1 || { echo ${ RAW_SQLITE_COPY }; continue; }
    copy="/to/\${db#/from/}"
    rm -f "$copy" "$copy-wal" "$copy-shm" "$copy-journal"
    if sqlite3 -readonly "$db" ".backup '$copy'"; then
        chown --reference="$db" "$copy"
        chmod --reference="$db" "$copy"
    else
        for file in "$db" "$db-wal" "$db-shm" "$db-journal"; do
            if [ -e "$file" ]; then cp -a "$file" "/to/\${file#/from/}"; fi
        done
        echo ${ RAW_SQLITE_COPY }
    fi
done
exit 0
`

/**
 * Codex, OpenCode and Antigravity keep conversations in volumes keyed by
 * the workspace path. A fork in another workspace gets a copy of the
 * parent's volumes so its native fork (or later resume) finds the history.
 * Claude's volumes are global and need nothing.
 * @param {Object} agent - Agent adapter
 * @param {Object} options
 * @param {string} options.from_workspace - Parent workspace
 * @param {string} options.to_workspace - Fork workspace
 * @param {boolean} [options.live=false] - Parent still runs (and may be writing)
 * @param {Function} [options.run_command=run] - Async command runner seam
 * @returns {Promise<number>} Volumes copied
 */
export const copy_agent_state_volumes = async ( agent, { from_workspace, to_workspace, live = false, run_command = run } ) => {

    if( resolve( from_workspace ) === resolve( to_workspace ) ) return 0

    const from = get_agent_state_mounts( agent, from_workspace )
    const to = get_agent_state_mounts( agent, to_workspace )
    const pairs = from.map( ( mount, index ) => [ mount.source, to[ index ]?.source ] )
        .filter( ( [ source, target ] ) => target && source !== target )
    const [ command, ...prefix ] = docker_command_prefix()

    for( const [ source, target ] of pairs ) {
        const output = await run_command( command, [
            ...prefix, `run`, `--rm`, `--network`, `none`, `--user`, `0`,
            `-v`, `${ source }:/from`, `-v`, `${ target }:/to`,
            `--entrypoint`, `sh`, get_image_name(), `-c`, COPY_STATE_SCRIPT,
        ], {}, 120_000 )
        if( live && String( output || `` ).includes( RAW_SQLITE_COPY ) ) {
            log.warn( `SQLite databases in ${ source } were copied file by file (no sqlite3 backup) while the parent runs; the fork's copy may be inconsistent.` )
        }
    }

    return pairs.length

}

/**
 * Copy the parent's raw transcript out of its volume (or live sandbox
 * container) so the fork can look things up. Best effort.
 * @param {Object} parent - Parent session record
 * @param {string} container_path - Transcript path inside the parent's state
 * @param {string} destination - Local directory to copy into
 * @param {Object} [options]
 * @param {boolean} [options.live=false] - Copy from the running parent container
 * @param {Function} [options.run_command=run] - Async command runner seam
 * @returns {Promise<string|null>} Local file path, or null
 */
const export_parent_transcript = async ( parent, container_path, destination, { live = false, run_command = run } = {} ) => {

    const [ command, ...prefix ] = docker_command_prefix()
    const local = join( destination, container_path.split( `/` ).pop() )
    const agent = get_agent( parent.agent )

    try {
        if( live && parent.modifiers?.includes( `sandbox` ) ) {
            await run_command( command, [ ...prefix, `cp`, `${ parent.container_id }:${ container_path }`, local ], {}, 60_000 )
            return local
        }

        // docker cp only reads containers, so park the volumes in an unstarted one
        const name = `babysit-fork-read-${ randomUUID() }`
        await run_command( command, [
            ...prefix, `create`, `--name`, name, `--network`, `none`,
            ...get_agent_state_mounts( agent, session_workspace( parent ) ).flatMap( mount => [ `-v`, `${ mount.source }:${ mount.target }:ro` ] ),
            parent.image_id || get_image_name(), `true`,
        ], {}, 60_000 )
        try {
            await run_command( command, [ ...prefix, `cp`, `${ name }:${ container_path }`, local ], {}, 60_000 )
        } finally {
            await run_command( command, [ ...prefix, `rm`, `-f`, name ], {}, 30_000 ).catch( () => null )
        }
        return local
    } catch ( error ) {
        log.debug( `Could not export the parent transcript: ${ error.message }` )
        return null
    }

}

// A copy mount uploads one local file into the stopped container before start
const copy_mount = ( source, target ) => {
    chmodSync( source, 0o644 )
    return { type: `copy`, source, target }
}

/**
 * Prompt text the fork adds to (or, after a native fork, sends instead of)
 * the normal launch prompt.
 * @param {Object} options
 * @param {string} options.filesystem - share, clone, or none
 * @param {string} options.history - native, handoff, or none
 * @param {string|null} options.parent_branch - Branch the parent works on
 * @param {string|null} options.clone_branch - Branch created for a clone fork
 * @param {boolean} options.parent_live - Whether the parent keeps running
 * @returns {string[]} Prompt paragraphs
 */
export const fork_prompt_notes = ( { filesystem, history, parent_branch, clone_branch, parent_live } ) => [
    ... history === `native` ? [ `This conversation was forked by babysit into a new session; the original session ${ parent_live ? `keeps running` : `has ended` }.` ] : [],
    ... filesystem === `share` && parent_live ? [ `You share /workspace with the original session, which may still be editing it.` ] : [],
    ... filesystem === `clone` ? [
        `/workspace is now a snapshot clone of the original session's tree${ clone_branch ? ` on the new branch ${ clone_branch }` : `` }.`,
        ... parent_branch ? [ `Do not push to the parent's branch ${ parent_branch }.` ] : [],
    ] : [],
    ... history === `handoff` ? [ `Read ${ HANDOFF_CONTAINER_PATH } first: babysit summarised the session this one was forked from there. Then continue that work.` ] : [],
]

/**
 * Fork a session into a fresh launch that keeps (or summarises) its chat.
 * @param {Object} cmd - Parsed fork command { session_id, agent, flags, passthrough }
 * @param {Object} [deps] - Seams for tests
 */
export const cmd_fork = async ( cmd, {
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
    start = cmd_start,
    close = close_session,
    attach = attach_session,
    ask = null,
    input = process.stdin,
    chdir = path => process.chdir( path ),
    read_transcript = read_parent_transcript,
    copy_volumes = copy_agent_state_volumes,
    export_transcript = export_parent_transcript,
    forks_dir = join( BABYSIT_DIR, `forks` ),
    clones_dir = CLONES_DIR,
    load_clone = load_managed_clone,
    env = process.env,
} = {} ) => {

    // Select the parent the same way babysit list numbers it
    const stored = list_stored_sessions_fn()
    const live = await list_sessions_fn()
    const ordered = order_active_sessions( live, stored )
    const { parent, number } = select_fork_parent( cmd.session_id, ordered, stored )
    const parent_live = live.some( tmux => tmux.name === parent.tmux_session )
    const parent_state = !parent_live ? `exited` : parent.stuck_at ? `stuck` : `live`
    const label = `${ number ? `#${ number } ` : `` }${ parent.name || parent.babysit_id }`

    const parent_sandbox = Boolean( parent.modifiers?.includes( `sandbox` ) )

    const agent = get_agent( cmd.agent || parent.agent )
    if( !agent ) throw new Error( `Unknown agent: ${ cmd.agent || parent.agent }` )

    const by_tmux = stored_by_tmux( stored )
    const taken = ordered.map( row => by_tmux.get( row.name )?.name ).filter( Boolean )
    const flags = merge_fork_flags( parent, cmd.flags, taken )
    const passthrough = merge_fork_passthrough( parent, agent.name, cmd.passthrough )

    // Only what was typed pre-agrees: a parent's inherited YOLO is no answer
    const typed = cmd.flags || {}
    const autonomous = Boolean( typed.yes || typed.yolo || env.AGENT_AUTONOMY_MODE === `yolo` )
    const ask_user = ask || ask_line

    // Clone membership follows clone_id: a read-only fork of a clone has no
    // clone_path of its own, but its files (and prune's family) are that clone's
    const parent_clone_id = parent.clone_id || null
    const parent_clone = parent_clone_id ? parent.clone_path || join( clones_dir, parent_clone_id ) : null
    const parent_tree = parent_clone || session_workspace( parent )

    // Show what is being forked before asking how
    const tree = describe_parent_tree( parent_sandbox ? null : parent_tree )
    log.info( `Forking ${ label } (${ parent.agent } → ${ agent.name })` )
    log.info( `  ${ format_parent_state( tree, parent_state ) }` )

    const filesystem = await choose_fork_filesystem( {
        flags,
        fallback: default_fork_filesystem( { parent_live, parent_stuck: parent_state === `stuck`, flags } ),
        assume_default: autonomous,
        ask,
        input,
    } )
    const history = plan_fork_history( { parent, agent, flags } )
    if( parent_sandbox && history.kind !== `none` ) log.warn( `The parent ran in a sandbox: its conversation lives only in its container, so the fork gets a summary${ parent_live ? `` : ` without the transcript` }.` )
    log.info( `  filesystem: ${ filesystem }, history: ${ history.kind } (${ history.reason })` )

    // Run from where the parent's files live; start.js derives /workspace from it.
    // Clone forks start from the clone's real original, so /original stays true
    // even when the parent is a read-only fork that ran inside the clone.
    const clone_original = parent_clone && !parent.clone_path ? load_clone( parent_clone_id, { clones_dir } )?.original_workspace : null
    const original = clone_original || session_original_workspace( parent )

    // Sharing a clone either looks into it (mudbox) or joins its family (writable)
    const read_only_clone = Boolean( filesystem === `share` && parent_clone && flags.mudbox )
    const joins_clone = Boolean( filesystem === `share` && parent_clone && !flags.mudbox )
    const needs_original = filesystem === `clone` || joins_clone
    if( needs_original && parent_clone && !parent.clone_path && !clone_original ) throw new Error( `Parent clone ${ parent_clone_id } no longer exists` )

    // Refuse vanished trees before any Docker work starts
    const launch_dir = read_only_clone ? parent_clone : original
    if( filesystem === `clone` && !existsSync( parent_tree ) ) throw new Error( `Parent workspace no longer exists: ${ parent_tree }` )
    if( filesystem !== `none` && !existsSync( launch_dir ) ) throw new Error( `Parent workspace no longer exists: ${ launch_dir }` )
    if( existsSync( launch_dir ) && statSync( launch_dir ).isDirectory() ) chdir( launch_dir )

    // Handoff material is built before launch: reading it can take a Docker round trip
    const fork_dir = join( forks_dir, randomUUID() )
    const mounts = []
    if( history.kind === `handoff` ) {

        mkdirSync( fork_dir, { recursive: true, mode: 0o700 } )
        const transcript = await read_transcript( parent, { live: parent_live } )

        // The raw transcript rides along so the fork can look up what the summary drops
        const exported = transcript?.transcript
            ? await export_transcript( parent, transcript.transcript, fork_dir, { live: parent_live } )
            : null
        const transcript_path = exported ? `${ TRANSCRIPT_CONTAINER_PREFIX }${ exported.split( `/` ).pop() }` : null

        const markdown = build_handoff_markdown( {
            parent,
            transcript,
            tree: { ...tree, unpushed: tree.unpushed_log },
            filesystem,
            transcript_path,
        } )
        const handoff_file = join( fork_dir, `handoff.md` )
        writeFileSync( handoff_file, markdown, { mode: 0o600 } )
        mounts.push( copy_mount( handoff_file, HANDOFF_CONTAINER_PATH ) )
        if( exported ) mounts.push( copy_mount( exported, transcript_path ) )
        if( !transcript ) log.warn( `Could not read the parent transcript; the handoff carries metadata and Git state only.` )

    }

    const fork = {
        // --account wins in start; otherwise a Claude → Claude fork keeps the parent's
        claude_account: agent.name === `claude` && parent.agent === `claude` ? parent.claude_account || null : null,
        // A writable share of a clone joins its family so prune keeps it
        join_clone_id: joins_clone ? parent_clone_id : null,
        clone_options: filesystem === `clone` ? { snapshot: true, tree: parent_clone } : null,
        record: {
            forked_from: parent.babysit_id,
            fork_filesystem: filesystem,
            fork_history: history.kind,
            fork_base: filesystem === `clone` ? tree.base || null : null,
            // The host copy is removed once uploaded; the fork reads it here
            fork_handoff: history.kind === `handoff` ? HANDOFF_CONTAINER_PATH : null,
            // A read-only look into a clone still counts as that clone's use
            ... read_only_clone ? { clone_id: parent_clone_id } : {},
        },
        // Runs inside start once the fork's workspace exists
        prepare: async ( { workspace, clone_branch } ) => {

            const native = history.kind === `native`

            // Volumes are keyed by the workspace the parent ran in
            if( native ) await copy_volumes( agent, { from_workspace: session_workspace( parent ), to_workspace: workspace, live: parent_live } )

            const notes = fork_prompt_notes( {
                filesystem,
                history: history.kind,
                parent_branch: tree.branch,
                clone_branch,
                parent_live,
            } )
            return {
                agent_args: native ? agent.flags.fork( parent.agent_session_id ) : [],
                mounts,
                // A native fork already carries the launch prompt in its history
                prompt: base => [ native ? `` : base, ...notes ].filter( Boolean ).join( `\n\n` ),
            }

        },
    }

    // Copy mounts are uploaded before start returns, so the host copy can go
    const session = await start( {
        verb: `start`,
        agent: agent.name,
        session_id: null,
        flags: { ...flags, clone: filesystem === `clone` || Boolean( fork.join_clone_id ) },
        passthrough,
        fork,
        detached: true,
    } ).finally( () => rmSync( fork_dir, { recursive: true, force: true } ) )
    if( !session ) return

    // The fork is up; the user may hand the work over completely (only asked when someone can answer)
    if( parent_live ) {
        const can_ask = !autonomous && ( ask || input.isTTY )
        const takeover = flags.takeover || can_ask && /^y(es)?$/i.test( ( await ask_user( `Close ${ label }? [y/N] ` ) ).trim() )
        if( takeover ) {
            await close( parent )
            log.info( `Closed ${ label }` )
        }
    }

    console.log( `Forked ${ label } → ${ session.name || session.babysit_id }` )
    if( !input.isTTY ) return console.log( `Attach with:\n\nbabysit open ${ session.babysit_id }\n` )

    await attach( session.tmux_session )
    console.log( `\nRe-attach with:\n\nbabysit open ${ session.babysit_id }\n` )

}
