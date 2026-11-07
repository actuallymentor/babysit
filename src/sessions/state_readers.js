/*
 * Python helpers shared by the inline native-state readers (transcript
 * check, fork handoff, completion capture). Prepended to each script at run
 * time, never installed in the image: probes run against a session's saved,
 * possibly older, image. Plain stdlib only; String.raw keeps the escapes
 * Python's. The transcript archive keeps its own copier (live SQLite backup,
 * secret filter).
 */
export const STATE_READERS = String.raw`
import contextlib, json, pathlib, shutil, sqlite3, tempfile


def json_records(file, limit=None, maximum=1048576):
    # JSON objects of a JSONL file, never following a symlink. A line over
    # maximum chars is skipped without holding it; limit caps lines read.
    if file.is_symlink() or not file.is_file(): return
    try:
        with file.open(errors='replace') as stream:
            read = 0
            while limit is None or read < limit:
                line = stream.readline(maximum + 1)
                if not line: break
                read += 1
                if len(line) > maximum:
                    while line and not line.endswith('\n'): line = stream.readline(maximum + 1)
                    continue
                try:
                    value = json.loads(line)
                    if isinstance(value, dict): yield value
                except ValueError: pass
    except OSError: pass


def codex_rollouts(sessions, ident=''):
    return sessions.glob('**/rollout-*' + ident + '.jsonl')


def codex_root_rollout(sessions, ident):
    # A root CLI or vscode thread; spawned subagents carry a structured source
    for file in codex_rollouts(sessions, ident):
        record = next(json_records(file), {})
        data = record.get('payload')
        if record.get('type') == 'session_meta' and isinstance(data, dict) \
                and data.get('id') == ident and data.get('source') in ('cli', 'vscode'):
            return True
    return False


@contextlib.contextmanager
def isolated_sqlite(file):
    # Never open live SQLite state in place: a crashed writer can leave a hot
    # journal or a WAL without SHM. Recover a private copy with its sidecars.
    with tempfile.TemporaryDirectory(prefix='babysit-sqlite-') as directory:
        target = pathlib.Path(directory) / file.name
        shutil.copyfile(file, target)
        for suffix in ('-wal', '-journal'):
            sidecar = pathlib.Path(str(file) + suffix)
            if sidecar.is_file() and not sidecar.is_symlink(): shutil.copyfile(sidecar, str(target) + suffix)
        db = sqlite3.connect(target, timeout=2)
        try:
            yield db
        finally:
            db.close()
`
