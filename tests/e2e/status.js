#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec_file = promisify( execFile )
const repo_root = fileURLToPath( new URL( `../../`, import.meta.url ) )
const run = async ( command, args ) => {
    const { stdout } = await exec_file( command, args, {
        cwd: repo_root,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
    } )
    return stdout
}

const wait_until = async ( label, predicate ) => {
    const deadline = Date.now() + 12_000
    while( Date.now() < deadline ) {
        if( await predicate() ) return
        await delay( 100 )
    }
    throw new Error( `Timed out waiting for ${ label }` )
}

const run_inside = async () => {
    const { start_monitor } = await import( '../../src/babysit/monitor.js' )
    const { save_session } = await import( '../../src/sessions/store.js' )
    const { codex } = await import( '../../src/agents/codex.js' )
    const socket = process.env.BABYSIT_TMUX_SOCKET
    const session = `babysit_status_regression`
    const state_file = `/tmp/status-mode`
    const tmux = args => run( `tmux`, [ `-L`, socket, ...args ] )
    const capture = () => tmux( [ `capture-pane`, `-pt`, session ] )
    const set_mode = async mode => {
        writeFileSync( state_file, mode )
        await wait_until( `${ mode } pane`, async () => ( await capture() ).includes( `fixture:${ mode }` ) )
    }
    const status = () => tmux( [ `show-option`, `-v`, `-t`, session, `@babysit_agent_status` ] ).then( value => value.trim() )
    const assert_list = async ( expected, label ) => {
        const output = await run( `node`, [ `src/index.js`, `list` ] )
        assert.match( output, new RegExp( `status-fixture\\s+${ expected }\\s+detached\\s+codex` ), `${ label }\n${ output }` )
        console.log( `PASS ${ label }: ${ expected }` )
    }

    // A deterministic interactive terminal keeps network, credentials and model
    // latency out of activity tests. Its redraws pass through a real PTY/tmux.
    writeFileSync( `/tmp/status-pane.mjs`, `
        import { readFileSync } from 'node:fs'
        let previous = ''
        let tick = 0
        setInterval( () => {
            const mode = readFileSync( '${ state_file }', 'utf8' )
            const footer = mode === 'idle-changing' ? 'usage refreshed ' + tick++ : '? for shortcuts'
            const busy = mode === 'running' ? '• Working (5s • esc to interrupt)\\n\\n' : ''
            const screen = 'OpenAI Codex\\nfixture:' + mode + '\\n\\n' + busy + '› Ask Codex to do anything\\n\\n' + footer
            if( screen !== previous ) process.stdout.write( '\\x1b[2J\\x1b[H' + screen )
            previous = screen
        }, 100 )
    ` )
    writeFileSync( state_file, `idle` )
    await tmux( [ `new-session`, `-d`, `-s`, session, `-x`, `120`, `-y`, `30`, `node /tmp/status-pane.mjs` ] )
    save_session( {
        babysit_id: `status-fixture`,
        name: `status-fixture`,
        agent: `codex`,
        tmux_session: session,
        pwd: `/tmp/status-workspace`,
        started_at: new Date().toISOString(),
        modifiers: [],
    } )
    await set_mode( `idle` )
    const { get_session_pane } = await import( '../../src/tmux/session.js' )
    const pane = await get_session_pane( session )
    assert.match( pane.pane_id, /^%\d+$/ )
    assert.equal( pane.attachment, `detached` )
    console.log( `PASS real tmux pane identity and attachment parsing` )

    await tmux( [ `set-option`, `-t`, session, `@babysit_agent_status`, `running` ] )
    await assert_list( `idle`, `idle pane overrides cached running` )
    await tmux( [ `set-option`, `-u`, `-t`, session, `@babysit_agent_status` ] )
    await assert_list( `idle`, `idle pane without cached status` )
    await set_mode( `running` )
    await tmux( [ `set-option`, `-t`, session, `@babysit_agent_status`, `idle` ] )
    await assert_list( `running`, `busy pane overrides cached idle` )

    // Exercise the production monitor independently of list's fresh inspection.
    // Polling, capture, activity publication and session liveness are all real.
    const monitor = start_monitor( {
        session_name: session,
        config: { idle_timeout_s: 10 },
        rules: [],
        agent_patterns: {},
        agent: codex,
    } )
    try {
        await wait_until( `monitor running`, async () => await status() === `running` )
        await delay( 3_500 )
        assert.equal( await status(), `running`, `a static busy footer must stay running after the stability timeout` )
        await assert_list( `running`, `static busy footer stays running` )

        await set_mode( `idle-changing` )
        await wait_until( `monitor idle despite footer redraws`, async () => await status() === `idle` )
        await delay( 1_200 )
        assert.equal( await status(), `idle`, `footer redraws must not reset idle activity` )
        await assert_list( `idle`, `changing idle footer stays idle` )

        await set_mode( `running` )
        await wait_until( `monitor running again`, async () => await status() === `running` )
        await assert_list( `running`, `running to idle to running transition` )

        // Force a real disappearance between enumeration and capture. Keeping
        // cached running here would conceal the failure from the user.
        const { cmd_list } = await import( '../../src/cli/list.js' )
        const { list_sessions } = await import( '../../src/tmux/session.js' )
        const lines = []
        const original_log = console.log
        console.log = ( ...values ) => lines.push( values.join( ` ` ) )
        try {
            await cmd_list( {
                list_sessions_fn: async () => {
                    const sessions = await list_sessions()
                    await tmux( [ `kill-session`, `-t`, session ] )
                    return sessions
                },
            } )
        } finally {
            console.log = original_log
        }
        assert.match( lines.join( `\n` ), /status-fixture\s+unknown\s+detached\s+codex/, `capture failure must be unknown` )
        console.log( `PASS actual tmux capture failure: unknown` )
    } finally {
        await tmux( [ `kill-session`, `-t`, session ] ).catch( () => {} )
        await monitor
    }
}

const run_docker = async () => {
    let docker_command = `docker`
    let docker_prefix = []
    try {
        await run( docker_command, [ `info` ] )
    } catch {
        docker_command = `sudo`
        docker_prefix = [ `-n`, `docker` ]
        await run( docker_command, [ ...docker_prefix, `info` ] )
    }
    const docker = args => run( docker_command, [ ...docker_prefix, ...args ] )
    const image = process.env.BABYSIT_E2E_BASE_IMAGE || `actuallymentor/babysit:latest`
    const image_id = ( await docker( [ `image`, `inspect`, image, `--format`, `{{.Id}}` ] ) ).trim()
    const run_id = `babysit-status-${ Date.now() }-${ process.pid }`
    let container_id
    try {
        // No mounts, daemon socket or host credentials enter the container.
        // Pin the existing image ID and delete only the exact ID created here.
        container_id = ( await docker( [
            `create`, `--name`, run_id,
            `--label`, `babysit.status_e2e=${ run_id }`,
            `--user`, `0`, `--entrypoint`, `sleep`,
            `--env`, `HOME=/tmp/status-home`,
            `--env`, `BABYSIT_TMUX_SOCKET=${ run_id }`,
            `--env`, `TERM=xterm-256color`,
            `--workdir`, `/app`,
            image_id, `infinity`,
        ] ) ).trim()
        await docker( [ `start`, container_id ] )
        await docker( [ `exec`, container_id, `mkdir`, `-p`, `/app/tests/e2e`, `/tmp/status-home` ] )
        for( const path of [ `src`, `node_modules`, `package.json`, `tests/e2e/status.js` ] ) {
            await docker( [ `cp`, join( repo_root, path ), `${ container_id }:/app/${ path }` ] )
        }
        console.log( `Status E2E container: ${ container_id } (${ image_id })` )
        await new Promise( ( resolve, reject ) => {
            const child = spawn( docker_command, [
                ...docker_prefix, `exec`, container_id, `node`, `tests/e2e/status.js`, `--inside`,
            ], { stdio: `inherit`, timeout: 90_000 } )
            child.on( `error`, reject )
            child.on( `close`, code => code === 0 ? resolve() : reject( new Error( `Status E2E exited ${ code }` ) ) )
        } )
    } finally {
        if( container_id ) await docker( [ `rm`, `-f`, container_id ] )
    }
}

if( process.argv.includes( `--inside` ) ) {
    assert.ok( process.env.BABYSIT_TMUX_SOCKET?.startsWith( `babysit-status-` ), `An isolated tmux socket is required` )
    assert.equal( process.env.HOME, `/tmp/status-home`, `An isolated HOME is required` )
    await run_inside()
} else {
    await run_docker()
}
