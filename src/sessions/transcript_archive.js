import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { get_agent } from '../agents/index.js'
import { docker_command_prefix, get_agent_state_mounts } from '../docker/run.js'
import { get_image_name } from '../docker/update.js'
import { read_babysit_config } from '../babysit/config.js'
import { write_atomic_json } from '../web_bridge/files.js'
import { log } from '../utils/log.js'
import { run } from '../utils/exec.js'
import { session_workspace } from './store.js'

/*
 * Transcript archive: mirror each agent's native transcripts into a host
 * directory (config `transcript_archive`, default ~/.babysit/transcripts).
 *
 *   <root>/volumes/<volume>/…         persistent agent state, mirrored incrementally
 *   <root>/sandbox/<babysit_id>/<dir>/ sandbox sessions, copied before removal
 *   <root>/sessions/<babysit_id>.json  index: agent, workspace, account, native id
 *
 * Native files carry every message, tool call, tool result and per-turn token
 * usage, subagents included: Claude writes <session>/subagents/agent-*.jsonl,
 * Codex gives every spawned agent its own rollout (parent links in its sqlite
 * state). Files are kept as the agents wrote them, never converted, so format
 * drift costs nothing at archive time.
 */

// Refresh while a session runs, so a crash or reboot loses at most this much
export const ARCHIVE_INTERVAL_MS = 10 * 60_000

// A full first pass over a large shared Claude volume can take a while
const ARCHIVE_TIMEOUT_MS = 10 * 60_000

// Credential-looking state (OpenCode auth.json, OAuth caches) never leaves its volume
const SECRET_FILE = /(auth|cred|token|secret|key)[^/]*\.json$/i

/*
 * Incremental mirror, run inside the session image: argv is the destination
 * root, then (source dir, destination name) pairs. A copy carries its
 * source's exact mtime, so an unchanged file costs one stat. SQLite databases
 * go through the backup API from a private copy (the volumes are read-only,
 * WAL contents included), stamped with the newest mtime of the db and its WAL.
 * Unique temp names keep concurrent monitors sharing a volume from colliding.
 */
export const MIRROR_SCRIPT = `
import os, re, shutil, sqlite3, sys, tempfile
root, pairs = sys.argv[1], sys.argv[2:]
secret = re.compile(r${ JSON.stringify( SECRET_FILE.source ) }, re.I)
os.umask(0o077)
copied = 0

def stamp(path):
    times = [os.stat(path).st_mtime_ns]
    for suffix in ('-wal', '-journal'):
        if os.path.isfile(path + suffix): times.append(os.stat(path + suffix).st_mtime_ns)
    return max(times)

def is_sqlite(path):
    try:
        with open(path, 'rb') as stream: return stream.read(16) == b'SQLite format 3\\x00'
    except OSError: return False

def backup(source, target):
    with tempfile.TemporaryDirectory() as directory:
        private = os.path.join(directory, 'db')
        shutil.copyfile(source, private)
        for suffix in ('-wal', '-journal'):
            if os.path.isfile(source + suffix): shutil.copyfile(source + suffix, private + suffix)
        with sqlite3.connect(private) as reader, sqlite3.connect(target) as writer: reader.backup(writer)

for source_root, name in zip(pairs[::2], pairs[1::2]):
    for directory, folders, files in os.walk(source_root):
        folders[:] = [folder for folder in folders if not os.path.islink(os.path.join(directory, folder))]
        relative = os.path.relpath(directory, source_root)
        out = os.path.normpath(os.path.join(root, name, relative))
        for file in files:
            source = os.path.join(directory, file)
            if secret.search(file) or file.endswith(('-wal', '-shm', '-journal')) or os.path.islink(source): continue
            target = os.path.join(out, file)
            try:
                mtime = stamp(source)
                if os.path.exists(target) and os.stat(target).st_mtime_ns == mtime: continue
                os.makedirs(out, exist_ok=True)
                handle, temporary = tempfile.mkstemp(dir=out, prefix='.' + file + '.', suffix='.babysit-partial')
                os.close(handle)
                try:
                    if is_sqlite(source): backup(source, temporary)
                    else: shutil.copyfile(source, temporary)
                    os.utime(temporary, ns=(mtime, mtime))
                    os.replace(temporary, target)
                finally:
                    if os.path.exists(temporary): os.unlink(temporary)
                copied += 1
            except (OSError, sqlite3.Error) as error:
                print('skip', source, error, file=sys.stderr)
print(copied)
`

/**
 * Archive root from the host config, or null when archiving is off.
 * @param {Object} [options] - Config reader seam
 * @returns {string|null}
 */
export const transcript_archive_root = ( { read_config = read_babysit_config } = {} ) => read_config().transcript_archive || null

const is_sandbox = session => Boolean( session.mode?.sandbox || session.sandbox || session.modifiers?.includes( `sandbox` ) )

/**
 * Delete credential-looking files from a copied tree.
 * @param {string} directory - Copied state
 */
const remove_secrets = directory => readdirSync( directory, { recursive: true } )
    .filter( path => SECRET_FILE.test( String( path ).split( `/` ).at( -1 ) ) )
    .forEach( path => rmSync( join( directory, String( path ) ), { force: true } ) )

/**
 * Index entry for one session: enough to find its files and who paid for them.
 * Pure.
 * @param {Object} session - Stored session
 * @param {Array<{ source: string, target: string }>} mounts - Agent state mounts
 * @returns {Object}
 */
export const archive_index_entry = ( session, mounts ) => ( {
    version: 1,
    babysit_id: session.babysit_id,
    name: session.name || null,
    agent: session.agent,
    workspace: session_workspace( session ),
    started_at: session.started_at || null,
    archived_at: new Date().toISOString(),
    agent_session_id: session.agent_session_id || null,
    claude_account: session.claude_account || null,
    account_switches: session.account_switches || [],
    transcripts: is_sandbox( session )
        ? mounts.map( ( { target } ) => join( `sandbox`, session.babysit_id, target.split( `/` ).at( -1 ) ) )
        : mounts.map( ( { source } ) => join( `volumes`, source ) ),
} )

/**
 * Mirror one session's transcripts into the archive and refresh its index.
 * Never throws: an archive failure must not disturb the session.
 * @param {Object} session - Stored session (agent, workspace, container_id, mode)
 * @param {Object} [options] - root plus command runner seam
 * @returns {Promise<boolean>} Whether the copy ran
 */
export const archive_session_transcripts = async ( session, {
    root = transcript_archive_root(),
    run_command = run,
} = {} ) => {

    if( !root ) return false
    const agent = get_agent( session.agent )
    if( !agent ) return false

    try {

        const sandbox = is_sandbox( session )
        const mounts = get_agent_state_mounts( agent, session_workspace( session ) )
        if( !mounts.length ) return false

        mkdirSync( root, { recursive: true, mode: 0o700 } )
        chmodSync( root, 0o700 )
        const [ command, ...prefix ] = docker_command_prefix()

        if( sandbox ) {

            // No volumes: the state only lives in the container, stopped or not
            if( !session.container_id ) return false
            const destination = join( root, `sandbox`, session.babysit_id )
            mkdirSync( destination, { recursive: true, mode: 0o700 } )
            for( const { target } of mounts ) {
                const out = join( destination, target.split( `/` ).at( -1 ) )
                await run_command( command, [ ...prefix, `cp`, `${ session.container_id }:${ target }/.`, out ], {}, ARCHIVE_TIMEOUT_MS )
                    .catch( error => log.debug( `Transcript copy of ${ target } failed: ${ error.message }` ) )
            }
            // docker cp takes everything; drop what looks like a credential
            remove_secrets( destination )

        } else {

            // Read-only volumes, no network, files owned by the host user
            mkdirSync( join( root, `volumes` ), { recursive: true, mode: 0o700 } )
            const user = process.getuid ? [ `--user`, `${ process.getuid() }:${ process.getgid() }` ] : []
            const pairs = mounts.flatMap( ( { source }, index ) => [ `/src/${ index }`, source ] )
            await run_command( command, [
                ...prefix, `run`, `--rm`, `--network`, `none`, ...user,
                ...mounts.flatMap( ( { source }, index ) => [ `-v`, `${ source }:/src/${ index }:ro` ] ),
                `-v`, `${ join( root, `volumes` ) }:/archive`,
                `--entrypoint`, `python3`, session.image_id || get_image_name(), `-c`, MIRROR_SCRIPT, `/archive`, ...pairs,
            ], {}, ARCHIVE_TIMEOUT_MS )

        }

        mkdirSync( join( root, `sessions` ), { recursive: true, mode: 0o700 } )
        write_atomic_json( join( root, `sessions`, `${ session.babysit_id }.json` ), archive_index_entry( session, mounts ) )
        return true

    } catch ( error ) {
        log.warn( `Could not archive transcripts for ${ session.babysit_id }: ${ error.message }` )
        return false
    }

}

/**
 * Archive now and every ARCHIVE_INTERVAL_MS until stopped. Runs are never
 * concurrent; stop() awaits the one in flight.
 * @param {Object|Function} session - Stored session, or a getter for the latest record
 * @param {Object} [options] - Archive and interval seams
 * @returns {{ run: Function, stop: Function }}
 */
export const start_transcript_archiver = ( session, {
    archive = archive_session_transcripts,
    interval_ms = ARCHIVE_INTERVAL_MS,
} = {} ) => {

    const current = () => typeof session === `function` ? session() : session
    let running = Promise.resolve()
    const run_once = () => {
        running = running.then( () => archive( current() ) ).catch( () => {} )
        return running
    }

    const timer = setInterval( run_once, interval_ms )
    timer.unref?.()

    return {
        run: run_once,
        stop: async () => {
            clearInterval( timer )
            await running
        },
    }

}
