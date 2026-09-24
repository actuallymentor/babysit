#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec_file = promisify( execFile )
const repository = fileURLToPath( new URL( `../../`, import.meta.url ) )
const root = mkdtempSync( join( tmpdir(), `babysit-session-numbers-e2e-` ) )
const workspace = join( root, `workspace` )
const elsewhere = join( root, `elsewhere` )
const socket = `babysit-session-numbers-${ process.pid }`
const env = { ...process.env, BABYSIT_HOME: root, BABYSIT_TMUX_SOCKET: socket, TERM: `xterm-256color` }

// This test owns its tmux server even when invoked from a real Babysit session.
delete env.TMUX
delete env.TMUX_PANE

const run = async ( command, args ) => {
    const { stdout } = await exec_file( command, args, { env, cwd: workspace, timeout: 35_000 } )
    return stdout.trim()
}
const cli_args = args => [ join( repository, `src/index.js` ), ...args ]
const cli = args => run( process.execPath, cli_args( args ) )
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const record_path = id => join( root, `sessions`, `${ id }.json` )

// Exercise a genuine foreground attach and keyboard detach. Inspecting the
// attached client proves which session was selected, beyond a success message.
const terminal_driver = String.raw`
import errno, os, pty, select, subprocess, sys, time

socket, expected = sys.argv[1:3]
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
output = b''
attached = False
deadline = time.monotonic() + 25
try:
    while True:
        if time.monotonic() > deadline:
            raise RuntimeError('Timed out waiting for attach/detach: ' + repr(output))
        if not attached:
            clients = subprocess.run(['tmux', '-L', socket, 'list-clients', '-F', '#{session_name}'], capture_output=True, text=True)
            names = clients.stdout.splitlines()
            if names:
                assert names == [expected], 'Attached to wrong session: ' + repr(names)
                attached = True
                os.write(master, b'\x02d')
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
        elif child.poll() is not None:
            break
    assert attached, 'CLI exited before attaching: ' + repr(output)
    assert child.wait(timeout=5) == 0, 'CLI failed after attach: ' + repr(output)
finally:
    if child.poll() is None:
        child.kill()
        child.wait()
    os.close(master)
    sys.stdout.buffer.write(output)
`

const attach = ( args, id ) => run( `python3`, [
    `-c`, terminal_driver, socket, `babysit_${ id }`, process.execPath, ...cli_args( args ),
] )

try {
    for( const directory of [ workspace, elsewhere, join( root, `sessions` ) ] ) mkdirSync( directory )

    // Creation order, chronology, active names, and workspace scope differ.
    // Closed history remains resumable; retired/pruned launches do not.
    const fixtures = [
        { babysit_id: `local`, pwd: workspace, day: 3 },
        { babysit_id: `closed`, pwd: workspace, day: 2, expected_open: false },
        { babysit_id: `foreign`, pwd: elsewhere, day: 4 },
        { babysit_id: `retired`, pwd: workspace, day: 5, superseded_by: `local` },
        { babysit_id: `pruned`, pwd: workspace, day: 6, expected_open: false, clone_pruned_at: `2026-01-07T00:00:00Z` },
    ]
    for( const { day, ...fixture } of fixtures ) {
        writeFileSync( record_path( fixture.babysit_id ), JSON.stringify( {
            agent: `codex`, expected_open: true, modifiers: [], credentials_cleaned: true,
            tmux_session: `babysit_${ fixture.babysit_id }`, started_at: `2026-01-0${ day }T00:00:00Z`,
            ...fixture,
        } ) )
    }
    const original_records = fixtures.map( ( { babysit_id } ) => readFileSync( record_path( babysit_id ), `utf8` ) )

    const scoped = await cli( [ `resume` ] )
    assert.match( scoped, /1\s+local\s/ )
    assert.match( scoped, /2\s+closed\s/ )
    assert.doesNotMatch( scoped, /foreign|retired|pruned/ )
    const global = await cli( [ `resume`, `--all` ] )
    assert.match( global, /1\s+foreign\s/ )
    assert.match( global, /2\s+local\s/ )
    assert.match( global, /3\s+closed\s/ )
    assert.doesNotMatch( global, /retired|pruned/ )
    assert.match( global, /resume <number\|babysit_id> --all/ )

    for( const args of [ [ `resume`, `0` ], [ `resume`, `3` ], [ `resume`, `4`, `--all` ], [ `codex`, `resume`, `0` ] ] ) {
        await assert.rejects( cli( args ), /No resumable session numbered/ )
    }
    await assert.rejects( cli( [ `claude`, `resume`, `1` ] ), /Session local belongs to codex, not claude/ )
    await assert.rejects( cli( [ `claude`, `resume`, `1`, `--all` ] ), /Session foreign belongs to codex, not claude/ )
    console.log( `PASS resume numbers follow workspace/global history and reject invalid numbers or agent mismatches` )

    // Legacy recovery stops before Docker or native agents, but still exercises
    // the real parser, registry order, lock, output, and candidate filtering.
    const recovery = await cli( [ `recover`, `--dry-run` ] )
    assert.match( recovery, /^1\. foreign: skipped/m )
    assert.match( recovery, /^2\. local: skipped/m )
    assert.doesNotMatch( recovery, /closed|retired|pruned/ )
    assert.match( await cli( [ `recover`, `2`, `--dry-run` ] ), /^2\. local: skipped/m )
    const selected = JSON.parse( await cli( [ `recover`, `2`, `--dry-run`, `--json` ] ) )
    assert.deepEqual( selected.map( result => result.id ), [ `local` ] )
    assert.match( selected[0].reason, /Legacy session/ )
    for( const number of [ `0`, `3` ] ) {
        await assert.rejects( cli( [ `recover`, number, `--dry-run` ] ), /No recovery session numbered/ )
    }
    console.log( `PASS recovery numbers match dry-run output and JSON selection, excluding closed/retired launches` )

    await tmux( [ `-f`, `/dev/null`, `new-session`, `-d`, `-s`, `babysit_local`, `sleep 300` ] )
    await tmux( [ `new-session`, `-d`, `-s`, `babysit_foreign`, `sleep 300` ] )
    await attach( [ `resume`, `1` ], `local` )
    await attach( [ `resume`, `1`, `--all` ], `foreign` )
    await attach( [ `codex`, `resume`, `1` ], `local` )
    assert.equal( await tmux( [ `list-clients` ] ), `` )
    assert.deepEqual( fixtures.map( ( { babysit_id } ) => readFileSync( record_path( babysit_id ), `utf8` ) ), original_records )
    console.log( `PASS numbered resume attaches the correct live session and detaches through a real terminal` )
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    rmSync( root, { recursive: true, force: true } )
}
