import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { acquire_clone_lock, prepare_clone_workspace } from '../../src/clone.js'
import { save_session } from '../../src/sessions/store.js'

const run = promisify( execFile )
const repository = fileURLToPath( new URL( `../../`, import.meta.url ) )
const root = mkdtempSync( join( tmpdir(), `babysit-prune-e2e-` ) )
const clones_dir = join( root, `.babysit/clones` )
const sessions_dir = join( root, `.babysit/sessions` )
const source = join( root, `source` )
const socket = `babysit-prune-e2e-${ process.pid }`
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const env = { ...process.env, HOME: root, BABYSIT_TMUX_SOCKET: socket, TERM: `xterm-256color` }

// Drive the actual readline prompts through a PTY. Sending all answers up front
// can lose input between questions and does not reproduce interactive usage.
const terminal_driver = String.raw`
import errno, json, os, pty, select, subprocess, sys, time

steps = json.loads(sys.argv[1])
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
pending = b''
deadline = time.monotonic() + 25
try:
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError('Timed out waiting for prune prompts: ' + repr(steps))
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
            if not chunk:
                break
            output += chunk
            pending += chunk
            if steps and steps[0][0].encode() in pending:
                prompt, answer = steps.pop(0)
                pending = pending.split(prompt.encode(), 1)[1]
                os.write(master, (answer + '\n').encode())
        elif child.poll() is not None:
            break
    if steps:
        raise RuntimeError('Prune exited before prompts: ' + repr(steps))
    sys.exit(child.wait(timeout=5))
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    sys.stdout.buffer.write(output)
`

const interactive = async steps => {

    const { stdout } = await run( `python3`, [
        `-c`, terminal_driver, JSON.stringify( steps ), process.execPath,
        join( repository, `src/index.js` ), `prune`,
    ], { env, cwd: root, timeout: 30_000 } )
    return stdout

}

let release_lock

try {
    mkdirSync( source )
    writeFileSync( join( source, `payload.txt` ), `Keep original workspace intact\n` )

    for( const clone_id of [ `unused-one`, `unused-two`, `active`, `protected`, `locked` ] ) {
        const clone = prepare_clone_workspace( { source, clone_id, clones_dir } )
        save_session( {
            babysit_id: clone_id, clone_id, clone_path: clone.workspace,
            name: clone_id, tmux_session: `babysit_prune_${ clone_id }`,
            status: `stopped`, started_at: new Date().toISOString(),
            ... clone_id === `protected` ? { recovery_version: 1, expected_open: true } : {} ,
        }, { directory: sessions_dir } )
    }

    await tmux( [ `new-session`, `-d`, `-s`, `babysit_prune_active`, `sleep`, `120` ] )
    release_lock = acquire_clone_lock( join( clones_dir, `locked` ), { clones_dir } )

    const listing = await run( process.execPath, [ join( repository, `src/index.js` ), `prune`, `--list` ], { env, cwd: root } )
    assert.match( listing.stdout, /5 clones currently.*\(2 active, 1 protected\)/ )
    assert.match( listing.stdout, /active: tmux/ )
    assert.match( listing.stdout, /active: launch/ )
    assert.match( listing.stdout, /protected: recovery pending/ )
    console.log( `PASS prune --list identifies real tmux and clone locks plus recovery intent` )

    const cancelled = await interactive( [ [ `Choose [1]: `, `2` ], [ `? [y/N] `, `` ] ] )
    assert.match( cancelled, /Prune cancelled/ )
    assert.ok( existsSync( join( clones_dir, `unused-one` ) ) )
    assert.ok( existsSync( join( clones_dir, `unused-two` ) ) )
    console.log( `PASS interactive prune defaults to cancellation` )

    const recent = await interactive( [ [ `Choose [1]: `, `` ] ] )
    assert.match( recent, /No clone workspaces match that policy/ )
    console.log( `PASS default 30-day policy preserves recent clones` )

    const pruned = await interactive( [ [ `Choose [1]: `, `2` ], [ `? [y/N] `, `y` ] ] )
    assert.match( pruned, /Pruned 2 of 2 clone workspaces/ )
    assert.doesNotMatch( pruned, /Could not prune|Skipped/ )
    for( const clone_id of [ `unused-one`, `unused-two` ] ) {
        assert.equal( existsSync( join( clones_dir, clone_id ) ), false )
        const record = JSON.parse( readFileSync( join( sessions_dir, `${ clone_id }.json` ), `utf8` ) )
        assert.equal( record.status, `pruned` )
        assert.ok( record.clone_pruned_at )
    }
    for( const clone_id of [ `active`, `protected`, `locked` ] ) {
        assert.ok( existsSync( join( clones_dir, clone_id, `payload.txt` ) ) )
    }
    assert.equal( readFileSync( join( source, `payload.txt` ), `utf8` ), `Keep original workspace intact\n` )
    console.log( `PASS select 2 + confirm y removes inactive clones and preserves active/protected clones and source` )
} finally {
    release_lock?.()
    await tmux( [ `kill-server` ] ).catch( () => {} )
    rmSync( root, { recursive: true, force: true } )
}
