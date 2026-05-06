#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'

const repo_root = resolve( fileURLToPath( new URL( `../../`, import.meta.url ) ) )
const run_id = `babysit-e2e-${ Date.now() }-${ Math.random().toString( 16 ).slice( 2, 8 ) }`
const tmux_socket = run_id
const base_image = process.env.BABYSIT_E2E_BASE_IMAGE || `babysit:e2e-base`
const fake_image = process.env.BABYSIT_E2E_FAKE_IMAGE || `babysit:e2e-fake`
const root = await mkdtemp( join( repo_root, `.babysit-e2e-${ run_id }-` ) )
const state_root = await mkdtemp( join( tmpdir(), `${ run_id }-` ) )
const home = join( state_root, `home` )
const workspaces_root = join( root, `workspaces` )
const workspace_tmp = join( root, `tmp` )
const docker_without_sudo = await command_ok( `docker`, [ `info` ] )
const docker_with_sudo = docker_without_sudo ? false : await command_ok( `sudo`, [ `docker`, `info` ] )
const use_sudo_docker = !docker_without_sudo && docker_with_sudo

mkdirSync( home, { recursive: true } )
mkdirSync( workspaces_root, { recursive: true } )
mkdirSync( workspace_tmp, { recursive: true } )
mkdirSync( join( home, `.codex` ), { recursive: true } )
writeFileSync( join( home, `.codex/auth.json` ), JSON.stringify( { refresh_token: `e2e-original-token` } ) )

const docker = async ( args, options = {} ) => {
    if( use_sudo_docker ) return run( `sudo`, [ `docker`, ...args ], options )
    return run( `docker`, args, options )
}

const tmux = ( args, options = {} ) => run( `tmux`, [ `-L`, tmux_socket, ...args ], options )

const e2e_env = () => {
    const env = {
        ...process.env,
        HOME: home,
        TMPDIR: workspace_tmp,
        CODEX_HOME: join( home, `.codex` ),
        AGENT_AUTONOMY_MODE: `yolo`,
        BABYSIT_TMUX_SOCKET: tmux_socket,
        BABYSIT_DOCKER_IMAGE: fake_image,
        BABYSIT_E2E_RUN_ID: run_id,
        BABYSIT_E2E_SIBLING_IMAGE: fake_image,
        LOG_LEVEL: process.env.LOG_LEVEL || `info`,
    }

    if( use_sudo_docker ) env.BABYSIT_DOCKER_USE_SUDO = `1`

    return env
}

/**
 * Run a command and capture its output.
 * @param {string} cmd - Executable
 * @param {string[]} [args=[]] - Arguments
 * @param {Object} [options={}] - Spawn options
 * @param {number} [options.timeout_ms=120000] - Timeout
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function run( cmd, args = [], options = {} ) {

    const { timeout_ms = 120_000, ...spawn_options } = options

    return new Promise( ( resolve_run, reject_run ) => {

        const child = spawn( cmd, args, {
            cwd: repo_root,
            env: process.env,
            stdio: [ `ignore`, `pipe`, `pipe` ],
            ...spawn_options,
        } )

        let stdout = ``
        let stderr = ``
        const timer = setTimeout( () => {
            child.kill( `SIGTERM` )
            reject_run( new Error( `Timed out after ${ timeout_ms }ms: ${ [ cmd, ...args ].join( ` ` ) }` ) )
        }, timeout_ms )

        child.stdout.on( `data`, chunk => stdout += chunk.toString() )
        child.stderr.on( `data`, chunk => stderr += chunk.toString() )
        child.on( `error`, error => {
            clearTimeout( timer )
            reject_run( error )
        } )
        child.on( `close`, code => {
            clearTimeout( timer )
            if( code === 0 ) return resolve_run( { stdout, stderr } )

            const command = [ cmd, ...args ].join( ` ` )
            reject_run( new Error( `${ command } exited ${ code }\nSTDOUT:\n${ stdout }\nSTDERR:\n${ stderr }` ) )
        } )

    } )

}

/**
 * Check whether a command succeeds.
 * @param {string} cmd - Executable
 * @param {string[]} args - Arguments
 * @returns {Promise<boolean>}
 */
async function command_ok( cmd, args ) {

    try {
        await run( cmd, args, { timeout_ms: 20_000 } )
        return true
    } catch {
        return false
    }

}

/**
 * Wait until a predicate succeeds.
 * @param {string} label - Failure label
 * @param {Function} predicate - Predicate returning truthy on success
 * @param {number} [timeout_ms=30000] - Timeout
 * @returns {Promise<*>}
 */
async function wait_until( label, predicate, timeout_ms = 30_000 ) {

    const deadline = Date.now() + timeout_ms

    while( Date.now() < deadline ) {
        const value = await predicate()
        if( value ) return value
        await new Promise( resolve_wait => setTimeout( resolve_wait, 250 ) )
    }

    throw new Error( `Timed out waiting for ${ label }` )

}

const ensure = ( condition, message ) => {
    if( !condition ) throw new Error( message )
}

const write_file = ( path, content ) => {
    mkdirSync( dirname( path ), { recursive: true } )
    writeFileSync( path, content )
}

const make_workspace = ( name, yaml, files = {} ) => {
    const workspace = join( workspaces_root, name )
    mkdirSync( workspace, { recursive: true } )
    write_file( join( workspace, `babysit.yaml` ), yaml )

    for( const [ relative_path, content ] of Object.entries( files ) ) {
        write_file( join( workspace, relative_path ), content )
    }

    return workspace

}

const latest_session = () => {
    const sessions_dir = join( home, `.babysit/sessions` )
    const files = existsSync( sessions_dir )
        ? readdirSync( sessions_dir ).filter( file => file.endsWith( `.json` ) )
        : []

    ensure( files.length > 0, `No Babysit session metadata was written` )

    const sessions = files.map( file => JSON.parse( readFileSync( join( sessions_dir, file ), `utf8` ) ) )
    return sessions.sort( ( a, b ) => String( b.started_at ).localeCompare( String( a.started_at ) ) )[0]
}

const launch_babysit = async ( workspace, args, timeout_ms = 90_000 ) => {

    // In a non-TTY test process, Babysit's foreground tmux attach exits
    // immediately after cmd_start has saved session metadata. The E2E harness
    // intentionally uses that metadata to keep driving the detached tmux pane.
    await run( `node`, [ join( repo_root, `src/index.js` ), `codex`, ...args ], {
        cwd: workspace,
        env: e2e_env(),
        timeout_ms,
    } )

    const session = latest_session()
    await wait_until( `tmux session ${ session.tmux_session }`, async () => {
        try {
            await tmux( [ `has-session`, `-t`, session.tmux_session ] )
            return true
        } catch {
            return false
        }
    }, 10_000 )

    return session
}

const capture = async ( session ) => {
    const { stdout } = await tmux( [ `capture-pane`, `-t`, session.tmux_session, `-p`, `-S`, `-1000` ] )
    return stdout
}

const send_text = async ( session, text ) => {
    await tmux( [ `send-keys`, `-t`, session.tmux_session, `-l`, text ] )
    await tmux( [ `send-keys`, `-t`, session.tmux_session, `Enter` ] )
}

const stop_session = async ( session ) => {
    if( !session ) return

    try {
        await send_text( session, `BABYSIT_E2E_EXIT` )
        await wait_until( `session ${ session.tmux_session } to stop`, async () => {
            try {
                await tmux( [ `has-session`, `-t`, session.tmux_session ] )
                return false
            } catch {
                return true
            }
        }, 15_000 )
    } catch {
        await tmux( [ `kill-session`, `-t`, session.tmux_session ] ).catch( () => null )
    }
}

const build_images = async () => {
    if( process.env.BABYSIT_E2E_SKIP_BUILD === `1` ) return

    if( process.env.BABYSIT_E2E_SKIP_BASE_BUILD !== `1` ) {
        console.log( `Building ${ base_image }` )
        await docker( [
            `build`,
            `-t`, base_image,
            `-f`, join( repo_root, `src/docker/assets/Dockerfile` ),
            join( repo_root, `src/docker/assets` ),
        ], { timeout_ms: 900_000 } )
    } else {
        console.log( `Using existing base image ${ base_image }` )
    }

    console.log( `Building ${ fake_image }` )
    await docker( [
        `build`,
        `-t`, fake_image,
        `--build-arg`, `BASE_IMAGE=${ base_image }`,
        `-f`, join( repo_root, `tests/e2e/assets/Dockerfile.fake` ),
        join( repo_root, `tests/e2e/assets` ),
    ], { timeout_ms: 300_000 } )
}

const run_default_session = async () => {
    const workspace = make_workspace( `default`, `config:
    initial_prompt: "BABYSIT_E2E_INITIAL_PROMPT"
    idle_timeout_s: 2
    commands:
        marker_command: "printf monitor-command > e2e-monitor-command.txt"
babysit:
    - on: "FAKE_AGENT_READY"
      do: marker_command
      timeout: 1
` )
    const log_path = join( workspace, `e2e.babysit.log` )
    const session = await launch_babysit( workspace, [ `--yolo`, `--docker`, `--log`, log_path ] )

    await wait_until( `initial prompt marker`, () => existsSync( join( workspace, `e2e-initial-prompt.txt` ) ) )
    await wait_until( `monitor command marker`, () => existsSync( join( workspace, `e2e-monitor-command.txt` ) ) )

    await send_text( session, `BABYSIT_E2E_MANUAL_PROMPT` )
    await wait_until( `manual prompt marker`, () => existsSync( join( workspace, `e2e-manual-prompt.txt` ) ) )

    await send_text( session, `BABYSIT_E2E_DOCKER` )
    await wait_until( `sibling docker marker`, () => existsSync( join( workspace, `e2e-sibling.txt` ) ), 45_000 )

    await wait_until( `tmux log`, () => existsSync( log_path ) && readFileSync( log_path, `utf8` ).includes( `OpenAI Codex` ) )
    ensure( readFileSync( log_path, `utf8` ).includes( `Babysit session start:` ), `tmux log is missing the Babysit header` )

    await send_text( session, `BABYSIT_E2E_ROTATE_CREDS` )
    await send_text( session, `BABYSIT_E2E_EXIT` )
    await wait_until( `credential sync flush`, () => {
        const content = readFileSync( join( home, `.codex/auth.json` ), `utf8` )
        return content.includes( `e2e-rotated-token` )
    }, 20_000 )

}

const run_mudbox_session = async () => {
    const workspace = make_workspace( `mudbox`, `config:
    initial_prompt: "BABYSIT_E2E_WRITE_ATTEMPT"
babysit: []
` )
    const session = await launch_babysit( workspace, [ `--mudbox`, `--yolo` ] )

    await wait_until( `mudbox write failure`, async () => ( await capture( session ) ).includes( `WRITE_FAILED /workspace/e2e-write-attempt.txt` ) )
    ensure( !existsSync( join( workspace, `e2e-write-attempt.txt` ) ), `mudbox wrote to the host workspace` )
    await stop_session( session )
}

const run_sandbox_session = async () => {
    const workspace = make_workspace( `sandbox`, `config:
    initial_prompt: "BABYSIT_E2E_SANDBOX_CHECK"
babysit: []
`, {
        'e2e-host-sentinel.txt': `host-only`,
    } )
    const session = await launch_babysit( workspace, [ `--sandbox`, `--yolo` ] )

    await wait_until( `sandbox sentinel absence`, async () => ( await capture( session ) ).includes( `SANDBOX_SENTINEL_ABSENT` ) )
    ensure( !existsSync( join( workspace, `e2e-sandbox-result.txt` ) ), `sandbox wrote a result to the host workspace` )
    await stop_session( session )
}

const run_dependency_session = async () => {
    const workspace = make_workspace( `dependency-isolation`, `config:
    initial_prompt: "BABYSIT_E2E_NODE_MODULES_CHECK"
babysit: []
`, {
        'package.json': `{"name":"babysit-e2e-deps"}`,
        'node_modules/host-sentinel.txt': `host node_modules should be hidden`,
    } )
    const session = await launch_babysit( workspace, [ `--yolo` ] )

    await wait_until( `dependency isolation marker`, () => {
        const marker = join( workspace, `e2e-node-modules.txt` )
        return existsSync( marker ) && readFileSync( marker, `utf8` ).includes( `isolated` )
    } )
    await stop_session( session )
}

const cleanup = async () => {
    await tmux( [ `kill-server` ] ).catch( () => null )

    try {
        const { stdout } = await docker( [ `ps`, `-aq`, `--filter`, `label=babysit.e2e_run=${ run_id }` ] )
        const ids = stdout.split( /\s+/ ).filter( Boolean )
        if( ids.length ) await docker( [ `rm`, `-f`, ...ids ] ).catch( () => null )
    } catch {
        // Cleanup should not mask the real failure.
    }

    if( process.env.BABYSIT_E2E_KEEP_ARTIFACTS !== `1` ) {
        rmSync( root, { recursive: true, force: true } )
        rmSync( state_root, { recursive: true, force: true } )
    } else {
        console.log( `E2E workspace artifacts kept at ${ root }` )
        console.log( `E2E state artifacts kept at ${ state_root }` )
    }
}

try {
    ensure( await command_ok( `tmux`, [ `-V` ] ), `tmux is required for E2E tests` )
    ensure( docker_without_sudo || use_sudo_docker, `Docker is required for E2E tests` )

    await build_images()

    await run_default_session()
    await run_mudbox_session()
    await run_sandbox_session()
    await run_dependency_session()

    console.log( `E2E passed` )
} finally {
    await cleanup()
}
