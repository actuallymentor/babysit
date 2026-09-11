import { build_private_tmpfile } from '../utils/tmpfile.js'

export const COMPLETION_HELPER_PATH = `/home/node/.babysit-capture/capture.py`
export const COMPLETION_PLUGIN_PATH = `/home/node/.config/opencode/plugins/babysit-completion.js`

// Kept in an imported JS module so Bun's standalone build includes the helper.
// Python is already installed in the image; its TOML parser preserves arbitrary
// existing Codex notify arrays without guessing at TOML syntax.
export const COMPLETION_HELPER_SOURCE = String.raw`import json, os, pathlib, subprocess, sys, tempfile, datetime, tomllib, re, fcntl, uuid, sqlite3


def root_hook(agent):
    root = int(os.environ.get('BABYSIT_COMPLETION_ROOT_PID', '0'))
    if not root:
        return False
    root_command = pathlib.Path('/proc', str(root), 'cmdline').read_bytes().split(b'\0')
    codex_shim = (agent == 'codex' and len(root_command) > 1
                  and os.path.basename(root_command[0].decode()) in ('node', 'nodejs')
                  and pathlib.Path(root_command[1].decode()).resolve().name == 'codex.js')
    pid = os.getppid()
    native = 0
    while pid >= 1:
        if pid == root:
            return True
        if pid == 1:
            return False
        status = pathlib.Path('/proc', str(pid), 'status').read_text()
        command = pathlib.Path('/proc', str(pid), 'cmdline').read_bytes().split(b'\0')
        executable = os.path.basename(command[0].decode()) if command else ''
        # Shell hook runners are expected. A second CLI/runtime between the
        # hook and root identifies an independently launched nested agent.
        if executable not in ('sh', 'bash', 'dash'):
            # Only the npm entrypoint needs one native child. A native root
            # must not grant the same exception to a nested native CLI.
            if codex_shim and executable == 'codex' and native == 0:
                native += 1
            else:
                return False
        pid = int(next(line.split()[1] for line in status.splitlines() if line.startswith('PPid:')))
    return False


def codex_root_session(session):
    if not re.fullmatch(r'[a-zA-Z0-9-]+', session):
        return False
    home = pathlib.Path(os.environ.get('CODEX_HOME', '/home/node/.codex'))
    for transcript in (home / 'sessions').glob('**/rollout-*' + session + '.jsonl'):
        with transcript.open() as file:
            metadata = json.loads(file.readline(65536))
        if metadata.get('type') == 'session_meta':
            data = metadata.get('payload', {})
            # A remote TUI on Babysit's owned app server records root sessions
            # as vscode. Process ancestry still excludes independently launched
            # CLIs, and structured subagent sources remain excluded here.
            source = data.get('source')
            managed = os.environ.get('BABYSIT_EFFORT_AGENT') == 'codex' and os.environ.get('BABYSIT_EFFORT_ENDPOINT', '').startswith('ws://127.0.0.1:')
            if data.get('id') == session and (source == 'cli' or (managed and source == 'vscode')):
                return True
    return False



def antigravity_root_session(session):
    if not re.fullmatch(r'[a-fA-F0-9-]{36}', session):
        return False
    root = pathlib.Path.home() / '.gemini/antigravity-cli'
    database = root / 'conversations' / (session + '.db')
    if not database.is_file() or database.is_symlink():
        return False
    # Native source 17 is CORTEX_TRAJECTORY_SOURCE_CLI. In-process subagents
    # share the CLI PID, so ancestry alone cannot establish the root binding.
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=2) as db:
        return db.execute('SELECT 1 FROM trajectory_meta WHERE cascade_id = ? AND source = 17 LIMIT 1', (session,)).fetchone() is not None


def antigravity_response(session, payload):
    if payload.get('fullyIdle') is not True or payload.get('error'):
        return None
    if payload.get('terminationReason') not in ('NO_TOOL_CALL', 'model_stop'):
        return None
    expected = pathlib.Path.home() / '.gemini/antigravity-cli/brain' / session / '.system_generated/logs/transcript_full.jsonl'
    supplied = payload.get('transcriptPath')
    if not isinstance(supplied, str) or pathlib.Path(supplied) != expected or expected.is_symlink():
        return None
    # The Stop hook supplies the full transcript. Keep only the final visible
    # model response, never tool output or the separate thinking field.
    latest = None
    with expected.open() as stream:
        for line in stream:
            record = json.loads(line)
            if record.get('type') == 'USER_INPUT':
                latest = None
            elif record.get('source') == 'MODEL' and record.get('type') == 'PLANNER_RESPONSE':
                latest = record
    if not latest or latest.get('status') != 'DONE' or latest.get('tool_calls'):
        return None
    payload['turn_id'] = str(payload.get('executionNum', '')) + ':' + str(latest.get('step_index', ''))
    return latest.get('content')


def durable_write(path, content):
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def persist_receipt(agent, name, content):
    if os.environ.get('BABYSIT_RECOVERY_IDENTITY') != '1':
        return
    state = {'claude': '/home/node/.claude/projects', 'codex': '/home/node/.codex/sessions',
             'antigravity': '/home/node/.gemini/antigravity-cli', 'opencode': '/home/node/.local/share/opencode'}[agent]
    persisted = pathlib.Path(state, '.babysit-identities')
    persisted.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)
    durable_write(persisted / (os.environ['BABYSIT_COMPLETION_LAUNCH_ID'] + name + '.json'), content)


def save_exit(agent, status, interrupted):
    receipt = json.dumps(dict(version=1, launch_id=os.environ['BABYSIT_COMPLETION_LAUNCH_ID'],
                              agent=agent, exit_status=int(status), interrupted=interrupted == '1',
                              exited_at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    persist_receipt(agent, '.exit', receipt)


def save(agent, payload):
    if agent == 'codex' and payload.get('type') not in ('agent-turn-complete', 'babysit-session-identity'):
        return
    if agent == 'claude' and payload.get('hook_event_name') not in ('SessionStart', 'Stop'):
        return
    if agent == 'antigravity' and payload.get('hook_event_name') not in ('PreInvocation', 'Stop'):
        return
    if not root_hook(agent):
        return
    session = payload.get('thread-id') if agent == 'codex' else payload.get('conversationId') if agent == 'antigravity' else payload.get('session_id')
    if not isinstance(session, str) or not session or len(session) > 256:
        return
    if payload.get('agent_id') or payload.get('parent_session_id'):
        return
    if agent == 'codex' and not codex_root_session(session):
        return
    if agent == 'antigravity' and not antigravity_root_session(session):
        return
    path = pathlib.Path(os.environ['BABYSIT_COMPLETION_FILE'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (path.parent / 'lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    binding = path.parent / 'session'
    if binding.exists() and binding.read_text() != session:
        if payload.get('hook_event_name') not in ('SessionStart', 'PreInvocation') and agent not in ('codex', 'opencode'):
            return
    identity = json.dumps(dict(
        version=1, launch_id=os.environ['BABYSIT_COMPLETION_LAUNCH_ID'], agent=agent,
        session_id=session, captured_at=datetime.datetime.now(datetime.timezone.utc).isoformat()))
    persist_receipt(agent, '', identity)
    durable_write(binding, session)
    durable_write(path.parent / 'identity.json', identity)
    if agent == 'codex':
        if payload.get('type') != 'agent-turn-complete':
            return
        text = payload.get('last-assistant-message')
    elif agent == 'claude':
        if payload.get('hook_event_name') != 'Stop':
            return
        text = payload.get('last_assistant_message')
    elif agent == 'antigravity':
        if payload.get('hook_event_name') != 'Stop':
            return
        text = antigravity_response(session, payload)
    else:
        text = payload.get('text')
    if not isinstance(text, str) or not text.strip():
        return
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]', '', text)
    text = re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]', '', text)
    maximum = 256 * 1024
    if len(text.encode()) > maximum:
        notice = '\n\n[Message truncated at 256 KiB]'
        text = text.encode()[:maximum - len(notice.encode())].decode('utf-8', errors='ignore') + notice
    record = dict(version=1, launch_id=os.environ['BABYSIT_COMPLETION_LAUNCH_ID'], agent=agent,
                  session_id=session, turn_id=str(payload.get('turn-id') or payload.get('turn_id') or uuid.uuid4())[:256],
                  text=text, completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    descriptor, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as file:
            json.dump(record, file, ensure_ascii=False)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def codex_notify(command):
    config = pathlib.Path(os.environ.get('CODEX_HOME', '/home/node/.codex'), 'config.toml')
    existing = tomllib.loads(config.read_text()).get('notify', []) if config.exists() else []
    # CLI overrides are resolved after the file, in their original order.
    for index, argument in enumerate(command):
        assignment = command[index + 1] if argument in ('-c', '--config') and index + 1 < len(command) else argument.removeprefix('--config=') if argument.startswith('--config=') else ''
        if assignment.strip().startswith('notify'):
            parsed = tomllib.loads(assignment)
            existing = parsed.get('notify', existing)
    return existing


def launch(agent, command):
    os.environ['BABYSIT_COMPLETION_ROOT_PID'] = str(os.getpid())
    original = command.copy()
    os.environ.pop('BABYSIT_COMPLETION_RESUME_ID', None)
    if agent == 'antigravity':
        # agy otherwise warns and silently starts a new conversation for an
        # unavailable --conversation ID. Refuse that before any prompt can run.
        options = command[:command.index('--')] if '--' in command else command
        for index, argument in enumerate(options):
            if argument != '--conversation' and not argument.startswith('--conversation='):
                continue
            session = options[index + 1] if argument == '--conversation' and index + 1 < len(options) else argument.removeprefix('--conversation=')
            try:
                valid = antigravity_root_session(session)
            except (OSError, sqlite3.Error):
                valid = False
            if not valid:
                print('Cannot resume Antigravity: exact native conversation is unavailable.', file=sys.stderr)
                sys.exit(1)
    if agent == 'opencode':
        # An explicit resume ID is authoritative; never infer it from recency.
        options = command[:command.index('--')] if '--' in command else command
        for index, argument in enumerate(options):
            session = options[index + 1] if argument in ('-s', '--session') and index + 1 < len(options) else argument.removeprefix('--session=') if argument.startswith('--session=') else ''
            if re.fullmatch(r'ses[a-zA-Z0-9_]+', session):
                os.environ['BABYSIT_COMPLETION_RESUME_ID'] = session
    try:
        if agent == 'codex':
            existing = codex_notify(command)
            notify = ['python3', __file__, 'codex', json.dumps(existing)]
            command[1:1] = ['-c', 'notify=' + json.dumps(notify)]
            # The capture override must win over an explicit notify passthrough.
            index = 3
            while index < len(command):
                if command[index] in ('-c', '--config') and index + 1 < len(command) and command[index + 1].strip().startswith('notify'):
                    del command[index:index + 2]
                elif command[index].startswith('--config=notify'):
                    del command[index]
                else:
                    index += 1
    except (OSError, UnicodeError, tomllib.TOMLDecodeError):
        # Let the native CLI resolve/report configurations this parser cannot
        # read. Optional capture must not replace its normal startup behavior.
        command = original
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__':
    mode = sys.argv[1]
    if mode == 'launch':
        launch(sys.argv[2], sys.argv[3:])
    elif mode == 'exit':
        save_exit(sys.argv[2], sys.argv[3], sys.argv[4])
    elif mode == 'notify-command':
        # The app-server config API omits legacy notify; share the launch parser.
        print(json.dumps(codex_notify(json.loads(sys.argv[2]))))
    else:
        # Completion reporting must never block or alter an agent response.
        try:
            payload = json.loads(sys.argv[3]) if mode == 'codex' else json.load(sys.stdin)
            if mode == 'antigravity':
                payload['hook_event_name'] = sys.argv[2]
            save(mode, payload)
        except Exception:
            pass
        if mode == 'codex':
            try:
                previous = json.loads(sys.argv[2])
                if payload.get('type') == 'agent-turn-complete' and isinstance(previous, list) and previous:
                    subprocess.run([*previous, sys.argv[3]], timeout=10, check=False)
            except Exception:
                pass
`

export const COMPLETION_PLUGIN_SOURCE = String.raw`import { spawn } from 'node:child_process'

export const BabysitCompletion = async ( { client } ) => {
    let active_session = null
    const publish = payload => new Promise( resolve => {
        const child = spawn( 'python3', [ '/home/node/.babysit-capture/capture.py', 'opencode' ], { stdio: [ 'pipe', 'ignore', 'ignore' ] } )
        child.on( 'error', resolve )
        child.on( 'close', resolve )
        child.stdin.on( 'error', () => {} )
        child.stdin.end( JSON.stringify( payload ) )
    } )
    const resumed = process.env.BABYSIT_COMPLETION_RESUME_ID
    if( resumed ) {
        try {
            const { data: session } = await client.session.get( { path: { id: resumed } } )
            if( session?.id === resumed && !session.parentID ) {
                active_session = resumed
                await publish( { session_id: resumed } )
            }
        } catch { /* Missing native sessions must not claim a recovery identity. */ }
    }
    return {
    'chat.message': async input => {
        try {
            const { data: session } = await client.session.get( { path: { id: input.sessionID } } )
            if( session && !session.parentID ) {
                active_session = input.sessionID
                await publish( { session_id: active_session } )
            }
        } catch { /* Ignore sessions that cannot be verified. */ }
    },
    event: async ( { event } ) => {
        if( event.type !== 'session.idle' ) return
        try {
            const session_id = event.properties.sessionID
            if( session_id !== active_session ) return
            const { data: session } = await client.session.get( { path: { id: session_id } } )
            if( !session || session.parentID ) return
            const { data: messages } = await client.session.messages( { path: { id: session_id } } )
            const latest = messages?.at( -1 )
            if( latest?.info.role !== 'assistant' || !latest.info.time?.completed || latest.info.error ) return
            if( latest.info.finish !== 'stop' && latest.info.finish !== 'end_turn' ) return
            const text = latest.parts.filter( part => part.type === 'text' && !part.synthetic && !part.ignored ).map( part => part.text ).join( '\n\n' )
            if( !text.trim() ) return
            await publish( { session_id, turn_id: latest.info.id, text } )
        } catch { /* An unavailable message must not interrupt the agent. */ }
    },
    }
}
`

/**
 * Stage runtime helpers into the container without mounting host state.
 * @param {string} agent - Native agent name
 * @returns {Object[]} Docker seed descriptors
 */
export const completion_capture_mounts = agent => {

    const files = [ [ COMPLETION_HELPER_PATH, COMPLETION_HELPER_SOURCE ] ]
    if( agent === `opencode` ) files.push( [ COMPLETION_PLUGIN_PATH, COMPLETION_PLUGIN_SOURCE ] )

    return files.map( ( [ target, content ] ) => {
        const transport = build_private_tmpfile( `completion`, `helper`, content, { file_mode: 0o644 } )
        if( !transport ) throw new Error( `Could not prepare completion capture` )
        return { type: `seed_file`, host: transport.file, container: target, source: transport.file, target, cleanup: transport.directory }
    } )

}

/**
 * Append completion and session-binding hooks, retaining the user's hooks.
 * @param {Object} settings - Claude settings or Antigravity hooks.json snapshot
 * @param {string} agent - Claude or Antigravity
 * @returns {Object} Updated settings
 */
export const add_completion_hooks = ( settings, agent ) => {

    if( agent === `antigravity` ) {
        settings[ `babysit-completion` ] = Object.fromEntries( [ `PreInvocation`, `Stop` ].map( event => [ event, [ {
            type: `command`, command: `python3 ${ COMPLETION_HELPER_PATH } antigravity ${ event }`, timeout: 5,
        } ] ] ) )
        return settings
    }

    const command = `python3 ${ COMPLETION_HELPER_PATH } ${ agent }`
    const hook = { hooks: [ { type: `command`, command, timeout: 5 } ] }
    settings.hooks = { ...settings.hooks }
    for( const name of [ `SessionStart`, `Stop` ] ) {
        settings.hooks[ name ] = [ ...settings.hooks[ name ] || [], hook ]
    }
    return settings

}
