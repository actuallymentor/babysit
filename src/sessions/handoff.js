import { get_agent } from '../agents/index.js'
import { docker_command_prefix, get_agent_state_mounts } from '../docker/run.js'
import { get_image_name } from '../docker/update.js'
import { run } from '../utils/exec.js'
import { session_workspace } from './store.js'

// Docker start/remove alone can take tens of seconds on a busy daemon
const READ_TIMEOUT_MS = 60_000

// ~10k tokens: enough context to continue, small enough to read in one go
export const HANDOFF_MAX_CHARS = 40_000
const PROMPT_MAX_CHARS = 2_000
const MESSAGE_MAX_CHARS = 3_000
const RECENT_MESSAGES = 6
const MAX_FILES = 60

// Babysit types its launch prompt as the first user message; it is not the user's task
const BABYSIT_PROMPT_MARKER = `Running inside a Babysit container.`

/**
 * Read a parent's own words and recent replies from native agent state.
 * Runs read-only inside a throwaway container (or the live sandbox container)
 * and prints one JSON object: { transcript, user, assistant, files }.
 * Arguments: agent, native id (may be empty: newest conversation), home root.
 */
export const READ_TRANSCRIPT = `
import collections, json, pathlib, re, shutil, sqlite3, sys, tempfile
agent, ident, root = (sys.argv[1:] + ['', '', ''])[:3]
root = root or '/home/node'
home = pathlib.Path(root)
user, files = [], []
assistant = collections.deque(maxlen=${ RECENT_MESSAGES * 2 })
transcript = None
LIMIT = ${ PROMPT_MAX_CHARS * 2 }
SKIP = ('<command-', '<local-command', 'Caveat:', '[Request interrupted', '<environment_context', '<user_instructions', '<task-notification', '<system-reminder', '# AGENTS.md instructions')
WRITE_TOOLS = ('Edit', 'Write', 'MultiEdit', 'NotebookEdit')


def keep(bucket, text):
    text = (text or '').strip()[:LIMIT]
    # Babysit's own launch prompt may arrive wrapped (e.g. as pasted content)
    if not text or text.startswith(SKIP) or '${ BABYSIT_PROMPT_MARKER }' in text[:400]: return
    # One prompt can be logged twice (event and item); keep it once
    if not bucket or bucket[-1] != text: bucket.append(text)


def touch(path):
    if isinstance(path, str) and path and path not in files: files.append(path)


def newest(candidates):
    found = [file for file in candidates if file.is_file() and not file.is_symlink()]
    return max(found, key=lambda file: file.stat().st_mtime) if found else None


def lines(file):
    try:
        with file.open(errors='replace') as stream:
            for line in stream:
                if len(line) > 8388608: continue
                try:
                    value = json.loads(line)
                    if isinstance(value, dict): yield value
                except ValueError: pass
    except OSError: pass


def texts(content, kind):
    if isinstance(content, str): return [content]
    if not isinstance(content, list): return []
    return [block.get('text', '') for block in content if isinstance(block, dict) and block.get('type') == kind]


def isolated_db(file):
    # Never open live SQLite state in place; copy it with crash sidecars first
    directory = tempfile.mkdtemp(prefix='babysit-handoff-')
    target = pathlib.Path(directory) / file.name
    shutil.copyfile(file, target)
    for suffix in ('-wal', '-journal'):
        sidecar = pathlib.Path(str(file) + suffix)
        if sidecar.is_file() and not sidecar.is_symlink(): shutil.copyfile(sidecar, str(target) + suffix)
    return sqlite3.connect(target, timeout=2)


if agent == 'claude':
    pattern = '*/' + (ident or '*') + '.jsonl'
    file = newest((home / '.claude/projects').glob(pattern))
    if file:
        transcript = str(file)
        for record in lines(file):
            if record.get('isSidechain') or record.get('isMeta'): continue
            message = record.get('message') or {}
            content = message.get('content')
            if record.get('type') == 'user' and isinstance(content, str): keep(user, content)
            if record.get('type') != 'assistant' or not isinstance(content, list): continue
            reply = '\\n'.join(texts(content, 'text')).strip()
            if reply: assistant.append(reply[:LIMIT])
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_use' and block.get('name') in WRITE_TOOLS:
                    tool_input = block.get('input') or {}
                    touch(tool_input.get('file_path') or tool_input.get('notebook_path'))
elif agent == 'codex':
    file = newest((home / '.codex/sessions').glob('**/rollout-*' + (ident or '') + '.jsonl'))
    if file:
        transcript = str(file)
        fallback_user, events_assistant = [], []
        for record in lines(file):
            payload = record.get('payload') or {}
            kind = payload.get('type')
            item = payload.get('item') or {}
            # Typed prompts arrive as user_message events (older) or completed UserMessage items (0.15x)
            if record.get('type') == 'event_msg' and kind == 'user_message': keep(user, payload.get('message'))
            elif record.get('type') == 'event_msg' and kind == 'item_completed' and item.get('type') == 'UserMessage':
                keep(user, '\\n'.join(texts(item.get('content'), 'text') + texts(item.get('content'), 'input_text')))
            elif record.get('type') == 'event_msg' and kind == 'agent_message': events_assistant.append(str(payload.get('message') or '')[:LIMIT])
            elif record.get('type') == 'response_item' and kind == 'message':
                role = payload.get('role')
                if role == 'user': keep(fallback_user, '\\n'.join(texts(payload.get('content'), 'input_text')))
                reply = '\\n'.join(texts(payload.get('content'), 'output_text')).strip()
                if role == 'assistant' and reply: assistant.append(reply[:LIMIT])
            elif record.get('type') == 'response_item':
                # apply_patch carries the touched paths in its patch header lines
                for match in re.finditer(r'\\*\\*\\* (?:Add|Update|Delete) File: ([^\\n\\\\"]+)', json.dumps(payload)): touch(match.group(1).strip())
        if not user: user = fallback_user
        if not assistant: assistant.extend(events_assistant)
elif agent == 'opencode':
    database = newest((home / '.local/share/opencode').glob('**/*.db'))
    try:
        if database:
            transcript = str(database)
            db = isolated_db(database)
            session = ident or (db.execute('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1').fetchone() or [''])[0]
            roles = {row[0]: json.loads(row[1]).get('role') for row in db.execute('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created', (session,))}
            for message_id, data in db.execute('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created', (session,)):
                part = json.loads(data)
                if part.get('synthetic'): continue
                if part.get('type') == 'text': keep(user, part.get('text')) if roles.get(message_id) == 'user' else assistant.append(str(part.get('text') or '')[:LIMIT])
                if part.get('type') == 'tool' and part.get('tool') in ('edit', 'write', 'patch', 'multiedit'): touch(((part.get('state') or {}).get('input') or {}).get('filePath'))
    except (sqlite3.Error, OSError, ValueError): pass
elif agent == 'antigravity':
    # No documented transcript format: point the fork at the conversation state
    root_dir = home / '.gemini/antigravity-cli'
    database = newest(root_dir.glob('conversations/' + (ident or '*') + '.db'))
    if database: transcript = str(database)
    logs = newest(root_dir.glob('brain/' + (ident or '*') + '/.system_generated/logs/*'))
    if logs:
        try: assistant.append(logs.read_text(errors='replace')[-LIMIT:])
        except OSError: pass

print(json.dumps({'transcript': transcript, 'user': user, 'assistant': list(assistant), 'files': files[:${ MAX_FILES * 2 }]}))
`

/**
 * Read the parent's conversation for a handoff. A live sandbox parent keeps
 * its state in the container itself; everything else reads the persistent
 * state volumes read-only in a throwaway, network-less container.
 * @param {Object} parent - Parent session record
 * @param {Object} [options]
 * @param {boolean} [options.live=false] - Whether the parent container still runs
 * @param {Function} [options.run_command=run] - Async command runner seam
 * @returns {Promise<Object|null>} { transcript, user, assistant, files }, or null when unreadable
 */
export const read_parent_transcript = async ( parent, { live = false, run_command = run } = {} ) => {

    const agent = get_agent( parent.agent )
    if( !agent ) return null

    const ident = /^[a-zA-Z0-9_-]{1,256}$/.test( parent.agent_session_id || `` ) ? parent.agent_session_id : ``
    const sandbox = parent.modifiers?.includes( `sandbox` )
    const [ command, ...prefix ] = docker_command_prefix()

    const args = sandbox
        ? live && parent.container_id
            ? [ ...prefix, `exec`, `-i`, parent.container_id, `python3`, `-c`, READ_TRANSCRIPT, parent.agent, ident ]
            : null
        : [
            ...prefix, `run`, `--rm`, `--network`, `none`, `--read-only`, `--tmpfs`, `/tmp:rw,nosuid,nodev,size=512m`, `--user`, `0`,
            ...get_agent_state_mounts( agent, session_workspace( parent ) ).flatMap( mount => [ `-v`, `${ mount.source }:${ mount.target }:ro` ] ),
            `--entrypoint`, `python3`, parent.image_id || get_image_name(), `-c`, READ_TRANSCRIPT, parent.agent, ident,
        ]
    if( !args ) return null

    try {
        const output = await run_command( command, args, {}, READ_TIMEOUT_MS )
        return JSON.parse( output )
    } catch {
        return null
    }

}

const clip = ( text, max ) => text.length > max ? `${ text.slice( 0, max ) }\n[…truncated]` : text
const quote = text => text.split( `\n` ).map( line => `> ${ line }` ).join( `\n` )

/**
 * Build the handoff a fork reads as its first prompt: the parent's original
 * requests, its latest replies, the files it touched, and the tree state.
 * Older material is dropped first when the cap is reached.
 * @param {Object} options
 * @param {Object} options.parent - Parent session record
 * @param {Object|null} options.transcript - read_parent_transcript result
 * @param {Object} [options.tree] - { branch, base, status, diff_stat, unpushed } at fork time
 * @param {string} [options.filesystem] - `share`, `clone`, or `none`
 * @param {string|null} [options.transcript_path] - Path the fork can open for lookups
 * @param {number} [options.max_chars] - Hard size cap
 * @returns {string} Markdown handoff
 */
export const build_handoff_markdown = ( {
    parent,
    transcript = null,
    tree = {},
    filesystem = `share`,
    transcript_path = null,
    max_chars = HANDOFF_MAX_CHARS,
} ) => {

    const prompts = ( transcript?.user || [] ).map( text => clip( text, PROMPT_MAX_CHARS ) )
    const replies = ( transcript?.assistant || [] ).slice( -RECENT_MESSAGES ).map( text => clip( text, MESSAGE_MAX_CHARS ) )
    const files = ( transcript?.files || [] ).slice( -MAX_FILES )
    const workspace = {
        share: `the same workspace the parent uses (changes are visible to both sessions)`,
        clone: `a snapshot clone of the parent's tree${ tree.base ? ` at ${ tree.base.slice( 0, 12 ) }` : `` }`,
        none: `an empty sandbox (no project mounted)`,
    }[ filesystem ]

    const header = [
        `# Babysit fork handoff`,
        ``,
        `You continue work started in another coding-agent session. Babysit summarised that session's transcript below; treat it as context. The user's original requests are the task.`,
        ``,
        `- Parent: ${ parent.name ? `"${ parent.name }" ` : `` }${ parent.babysit_id } (${ parent.agent }, flags: ${ parent.modifiers?.length ? parent.modifiers.join( `,` ) : `none` })`,
        `- Your workspace: ${ workspace }`,
        ... tree.branch ? [ `- Parent branch: ${ tree.branch }` ] : [],
        ... transcript_path ? [ `- Full parent transcript (read-only lookups): ${ transcript_path }` ] : [],
        ... transcript ? [] : [ `- The parent transcript could not be read; ask the user for missing context.` ],
    ]

    const tree_section = [
        ... tree.status ? [ `## Working tree at fork time`, ``, `\`\`\``, clip( tree.status, 4_000 ), `\`\`\`` ] : [],
        ... tree.diff_stat ? [ ``, `Uncommitted changes:`, ``, `\`\`\``, clip( tree.diff_stat, 4_000 ), `\`\`\`` ] : [],
        ... tree.unpushed ? [ ``, `Unpushed commits:`, ``, `\`\`\``, clip( tree.unpushed, 2_000 ), `\`\`\`` ] : [],
    ]

    // Sections in priority order; the oldest prompts and replies go first when trimming
    const render = ( prompt_count, reply_count ) => [
        ...header,
        ``,
        `## Original user requests`,
        ``,
        ... prompts.length ? [
            ... prompt_count < prompts.length ? [ `(${ prompts.length - prompt_count } earlier requests omitted)`, `` ] : [],
            ...prompts.slice( prompts.length - prompt_count ).flatMap( ( text, index ) => [ `${ prompts.length - prompt_count + index + 1 }.`, quote( text ), `` ] ),
        ] : [ `(none found)`, `` ],
        `## Latest assistant messages`,
        ``,
        ... replies.length ? replies.slice( replies.length - reply_count ).flatMap( text => [ quote( text ), `` ] ) : [ `(none found)`, `` ],
        ... files.length ? [ `## Files the parent touched`, ``, ...files.map( file => `- ${ file }` ), `` ] : [],
        ...tree_section,
    ].join( `\n` ).trim() + `\n`

    let prompt_count = prompts.length
    let reply_count = replies.length
    let markdown = render( prompt_count, reply_count )

    // Keep the first request (the task) and the last reply (where it stopped) longest
    while( markdown.length > max_chars && ( prompt_count > 1 || reply_count > 1 ) ) {
        if( reply_count > 1 && ( reply_count >= prompt_count || prompt_count <= 1 ) ) reply_count--
        else prompt_count--
        markdown = render( prompt_count, reply_count )
    }

    return clip( markdown, max_chars )

}
