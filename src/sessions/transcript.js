import { get_agent } from '../agents/index.js'
import { docker_command_prefix, get_agent_state_mounts } from '../docker/run.js'
import { run } from '../utils/exec.js'
import { session_workspace } from './store.js'

// Include Docker's start/remove overhead, which can exceed 30 seconds even for
// a tiny read-only probe on a busy daemon. The boot sweep remains bounded.
const PROBE_TIMEOUT_MS = 60_000

// Inspect only native state volumes, without network, credentials or workspace
// writes. A missing conversation must never turn an unattended resume into new work.
export const CHECK_TRANSCRIPT = `
import json, pathlib, sqlite3, sys, tempfile, shutil
agent, ident = sys.argv[1:]
home = pathlib.Path('/home/node')
found = False


def records(file, maximum=1048576):
    if file.is_symlink() or not file.is_file(): return
    try:
        with file.open() as stream:
            # Claude may prepend queue/title events. Bound individual records,
            # but inspect enough history to find real root conversation data.
            for _ in range(256):
                line = stream.readline(maximum + 1)
                if not line or len(line) > maximum: break
                try:
                    value = json.loads(line)
                    if isinstance(value, dict): yield value
                except ValueError: pass
    except (OSError, UnicodeError): pass


def document(file):
    if file.is_symlink() or not file.is_file(): return {}
    try:
        if file.stat().st_size > 64 * 1024 * 1024: return {}
        value = json.loads(file.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, UnicodeError): return {}


if agent == 'claude':
    for file in (home / '.claude/projects').glob('*/' + ident + '.jsonl'):
        found = found or any(record.get('sessionId') == ident and record.get('type') in ('user', 'assistant')
                            and not record.get('isSidechain') for record in records(file))
elif agent == 'codex':
    for file in (home / '.codex/sessions').glob('**/rollout-*' + ident + '.jsonl'):
        record = next(records(file), {})
        data = record.get('payload', {})
        if record.get('type') == 'session_meta' and isinstance(data, dict):
            found = found or data.get('id') == ident and data.get('source') in ('cli', 'vscode')
elif agent == 'gemini':
    for file in (home / '.gemini/tmp').glob('**/session-*'):
        if file.suffix not in ('.json', '.jsonl'): continue
        record = next(records(file), {})
        # Current Gemini appends JSONL; older releases wrote one pretty JSON
        # document. Both must contain an exact native session ID.
        if record.get('sessionId') != ident: record = document(file)
        found = found or record.get('sessionId') == ident and bool(record.get('projectHash'))
elif agent == 'opencode':
    root = home / '.local/share/opencode'
    for file in root.glob('storage/session/*/' + ident + '.json'):
        record = document(file)
        found = found or record.get('id') == ident and not record.get('parentID')
    for file in root.glob('**/*.db'):
        if found: break
        if file.is_symlink() or not file.is_file(): continue
        try:
            # A crashed SQLite writer can leave a hot journal or a WAL without
            # SHM. Recover an isolated copy; never modify the original volume.
            with tempfile.TemporaryDirectory(prefix='babysit-transcript-') as directory:
                target = pathlib.Path(directory) / file.name
                shutil.copyfile(file, target)
                for suffix in ('-wal', '-journal'):
                    sidecar = pathlib.Path(str(file) + suffix)
                    if sidecar.is_file() and not sidecar.is_symlink():
                        shutil.copyfile(sidecar, str(target) + suffix)
                with sqlite3.connect(target, timeout=2) as db:
                    found = db.execute('SELECT 1 FROM session WHERE id = ? AND parent_id IS NULL LIMIT 1', (ident,)).fetchone() is not None
        except (sqlite3.Error, OSError): pass
sys.exit(0 if found else 1)
`

/** Verify an exact native conversation in existing persistent volumes before resuming. */
export const verify_session_transcript = async ( session, { run_command = run } = {} ) => {

    if( !/^[a-zA-Z0-9_-]{1,256}$/.test( session.agent_session_id || `` ) ) {
        throw new Error( `Missing exact native conversation ID` )
    }
    if( !/^sha256:[a-f0-9]{64}$/.test( session.image_id || `` ) ) throw new Error( `Missing saved image identity` )
    const agent = get_agent( session.agent )
    if( !agent ) throw new Error( `Unsupported agent: ${ session.agent }` )
    if( session.mode?.sandbox || session.sandbox || session.modifiers?.includes( `sandbox` ) ) throw new Error( `Sandbox conversations are ephemeral` )
    const mounts = get_agent_state_mounts( agent, session_workspace( session ) )
    const [ command, ...prefix ] = docker_command_prefix()
    await run_command( command, [ ...prefix, `volume`, `inspect`, ...mounts.map( mount => mount.source ) ], {}, 15_000 )
    try {
        await run_command( command, [
            ...prefix, `run`, `--rm`, `--network`, `none`, `--read-only`, `--tmpfs`, `/tmp:rw,nosuid,nodev,size=512m`, `--user`, `0`,
            ...mounts.flatMap( mount => [ `-v`, `${ mount.source }:${ mount.target }:ro` ] ),
            `--entrypoint`, `python3`, session.image_id, `-c`, CHECK_TRANSCRIPT,
            session.agent, session.agent_session_id,
        ], {}, PROBE_TIMEOUT_MS )
    } catch {
        throw new Error( `Exact conversation could not be read from its saved volumes: ${ session.agent_session_id }` )
    }

}


const READ_IDENTITY = `
import os, pathlib, stat, sys
root, launch_id, suffix = sys.argv[1:]
path = pathlib.Path(root, '.babysit-identities', launch_id + suffix + '.json')
try:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > 4096: sys.exit(1)
        content = os.read(descriptor, 4097)
        if len(content) > 4096: sys.exit(1)
        sys.stdout.buffer.write(content)
    finally:
        os.close(descriptor)
except FileNotFoundError:
    pass
`

/**
 * Recover the last fsynced root binding even when host polling missed /clear.
 * Returns null when no mirror was written; unreadable existing state fails closed.
 * @param {Object} session - Launch with verified owner, immutable image and capture ID
 * @param {Object} [options] - Async command runner seam
 * @returns {Promise<Object|null>} Authoritative native identity
 */
const read_durable_receipt = async ( session, suffix, run_command ) => {

    const launch_id = session.completion_capture?.launch_id
    if( !/^[a-f0-9-]{36}$/.test( launch_id || `` ) || session.mode?.sandbox || session.sandbox || session.modifiers?.includes( `sandbox` ) ) return null
    if( !/^sha256:[a-f0-9]{64}$/.test( session.image_id || `` ) ) throw new Error( `Missing saved image identity` )
    const agent = get_agent( session.agent )
    if( !agent ) throw new Error( `Unsupported agent: ${ session.agent }` )
    const [ mount ] = get_agent_state_mounts( agent, session_workspace( session ) )
    const [ command, ...prefix ] = docker_command_prefix()
    await run_command( command, [ ...prefix, `volume`, `inspect`, mount.source ], {}, 15_000 )
    const output = await run_command( command, [
        ...prefix, `run`, `--rm`, `--network`, `none`, `--read-only`, `--user`, `0`,
        `-v`, `${ mount.source }:${ mount.target }:ro`,
        `--entrypoint`, `python3`, session.image_id, `-c`, READ_IDENTITY, mount.target, launch_id, suffix,
    ], {}, PROBE_TIMEOUT_MS )
    if( !output.trim() ) return null
    if( Buffer.byteLength( output ) > 4096 ) throw new Error( `Oversized durable session identity` )
    const record = JSON.parse( output )
    if( record?.version !== 1 || record.launch_id !== launch_id || record.agent !== session.agent ) {
        throw new Error( `Invalid durable session receipt` )
    }
    return record

}

/** Recover the last fsynced root binding, including /clear changes missed by host polling. */
export const refresh_durable_identity = async ( session, { run_command = run } = {} ) => {

    const record = await read_durable_receipt( session, ``, run_command )
    if( !record ) return null
    if( typeof record.session_id !== `string` || !/^[a-zA-Z0-9_-]{1,256}$/.test( record.session_id )
        || typeof record.captured_at !== `string` || !Number.isFinite( Date.parse( record.captured_at ) ) ) {
        throw new Error( `Invalid durable session identity` )
    }
    return record

}

/** Read a native exit receipt; status zero counts as clean only when interrupted is false. */
export const read_durable_exit = async ( session, { run_command = run } = {} ) => {

    const record = await read_durable_receipt( session, `.exit`, run_command )
    if( !record ) return null
    if( !Number.isInteger( record.exit_status ) || record.exit_status < 0 || record.exit_status > 255
        || typeof record.interrupted !== `boolean` || typeof record.exited_at !== `string`
        || !Number.isFinite( Date.parse( record.exited_at ) ) ) {
        throw new Error( `Invalid durable session exit` )
    }
    return record

}
