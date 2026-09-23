#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec_file = promisify( execFile )
const root = mkdtempSync( join( tmpdir(), `babysit-close-e2e-` ) )
const socket = `babysit-close-${ process.pid }`
const env = { ...process.env, BABYSIT_HOME: root, BABYSIT_TMUX_SOCKET: socket }
const containers = []
const run = async ( command, args ) => {
    const { stdout } = await exec_file( command, args, { env, timeout: 60_000 } )
    return stdout.trim()
}
const docker = args => env.BABYSIT_DOCKER_USE_SUDO === `1` ? run( `sudo`, [ `-n`, `docker`, ...args ] ) : run( `docker`, args )
const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
const cli = args => run( process.execPath, [ `src/index.js`, ...args ] )
const record = id => join( root, `sessions`, `${ id }.json` )

try {
    mkdirSync( join( root, `sessions` ) )
    // Reverse creation order: selection must follow the live list's order.
    for( const id of [ `second`, `first` ] ) {
        const container_id = await docker( [ `run`, `-d`, `--init`, `--entrypoint`, `sleep`, process.env.BABYSIT_E2E_FAKE_IMAGE || `babysit:e2e-fake`, `300` ] )
        containers.push( container_id )
        const name = `babysit_${ id }`
        await tmux( [ `new-session`, `-d`, `-s`, name, `sleep 300` ] )
        writeFileSync( record( id ), JSON.stringify( {
            babysit_id: id, tmux_session: name, container_id, agent: `codex`,
            name: id, pwd: root, expected_open: true, credentials_cleaned: true,
            started_at: new Date().toISOString(), modifiers: [],
        } ) )
    }
    const listed = await cli( [ `list` ] )
    assert.match( listed, /1\s+first\s/ )
    assert.match( listed, /2\s+second\s/ )
    await assert.rejects( cli( [ `close`, `0` ] ), /No active session numbered 0/ )
    assert.match( await cli( [ `close`, `1` ] ), /Closed first/ )
    assert.equal( JSON.parse( readFileSync( record( `first` ) ) ).expected_open, false )
    assert.equal( JSON.parse( readFileSync( record( `second` ) ) ).expected_open, true )
    assert.equal( await tmux( [ `list-sessions`, `-F`, `#{session_name}` ] ), `babysit_second` )
    assert.match( await cli( [ `list` ] ), /1\s+second\s/ )
    assert.match( await cli( [ `close`, `1` ] ), /Closed second/ )
    console.log( `PASS list ordinals select the exact session, reject zero, and renumber after close` )
} finally {
    await tmux( [ `kill-server` ] ).catch( () => {} )
    for( const container of containers ) {
        await docker( [ `stop`, `--time`, `1`, container ] ).catch( () => {} )
        await docker( [ `rm`, container ] ).catch( () => {} )
    }
    rmSync( root, { recursive: true, force: true } )
}
