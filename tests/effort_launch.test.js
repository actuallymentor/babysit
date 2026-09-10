import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { codex_launch_plan, opencode_launch_plan } from '../src/docker/assets/effort/launch.mjs'

const temporary_dirs = []
afterEach( () => temporary_dirs.splice( 0 ).forEach( directory => rmSync( directory, { recursive: true, force: true } ) ) )

const fixture = () => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-effort-launch-` ) )
    temporary_dirs.push( directory )
    const executable = join( directory, `codex` )
    writeFileSync( executable, `#!${ process.execPath }
import { writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
const server = args.includes('app-server')
const record = kind => writeFileSync(process.env.RECORD_DIR + '/' + kind + '.json', JSON.stringify({args,pid:process.pid,endpoint:process.env.BABYSIT_EFFORT_ENDPOINT,agent:process.env.BABYSIT_EFFORT_AGENT,capture:process.env.CAPTURE_SEEN}))
record(server ? 'server' : 'tui')
if (server) {
  if (process.env.SERVER_NOISE) writeFileSync(2, 'background diagnostic\\n'.repeat(8192) + 'server diagnostic tail\\n')
  if (process.env.SERVER_FAIL) process.exit(17)
  const endpoint = new URL(args[args.indexOf('--listen') + 1])
  Bun.serve({ hostname: endpoint.hostname, port: Number(endpoint.port), fetch(request, server) { if(server.upgrade(request)) return; return new Response('no', {status:400}) }, websocket: { message(socket, value) {
    const request = JSON.parse(value)
    if (request.method === 'thread/read' && process.env.OBSERVER_FAIL) { socket.send(JSON.stringify({id:request.id,error:{message:'observer failure'}})); return }
    const result = request.method === 'config/read' ? {config:{notify:['python3','/home/node/.babysit-capture/capture.py','codex','[]']}} : request.method === 'thread/loaded/list' ? {data:[]} : {userAgent:'fixture'}
    if(request.id !== undefined) socket.send(JSON.stringify({id:request.id,result}))
    if(request.method === 'thread/loaded/list' && process.env.OBSERVER_FAIL) socket.send(JSON.stringify({method:'thread/started',params:{thread:{id:'root'}}}))
  } } })
  if(process.env.SERVER_TOOL) {
    const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', detached: true})
    writeFileSync(process.env.RECORD_DIR + '/tool.json', JSON.stringify({pid:tool.pid}))
  }
  if(process.env.SERVER_DIES) setTimeout(() => process.exit(19), 400)
  if(process.env.SERVER_STUBBORN) process.on('SIGTERM', () => {})
} else {
  if(process.env.TUI_DIAGNOSTIC) process.stderr.write('frontend stderr; tty=' + Boolean(process.stderr.isTTY) + '\\n')
  if(process.env.OBSERVER_FAIL) { setTimeout(() => { process.stderr.write('frontend finished\\n'); process.exit(0) }, 300); setInterval(() => {}, 1000) }
  else if(process.env.TUI_WAIT) setInterval(() => {}, 1000)
  else process.exit(Number(process.env.TUI_STATUS || 0))
}
`, { mode: 0o755 } )
    return { directory, executable }
}

const run_fixture = ( { directory, executable, captured, terminal }, args = [], env = {} ) => {
    const prefix = captured ? [ `python3`, `/home/node/.babysit-capture/capture.py`, `launch`, `codex` ] : []
    const command = [ `node`, `src/docker/assets/effort/launch.mjs`, ...prefix, executable, ...args ]
    // A real PTY catches terminal corruption that pipe-only launch tests miss.
    const pty = `import os, pty, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
try:
    while True:
        data = os.read(master, 65536)
        if not data: break
        os.write(1, data)
except OSError:
    pass
finally:
    os.close(master)
sys.exit(child.wait())`
    const invocation = terminal ? [ `python3`, `-c`, pty, ...command ] : command
    const child = spawn( invocation[ 0 ], invocation.slice( 1 ), { env: { ...process.env, RECORD_DIR: directory, ...env }, stdio: [ `ignore`, `pipe`, `pipe` ] } )
    let stdout = ``
    child.stdout.on( `data`, chunk => {
        stdout += chunk
    } )
    let stderr = ``
    child.stderr.on( `data`, chunk => {
        stderr += chunk
    } )
    child.result = new Promise( resolve => child.on( `close`, ( code, signal ) => resolve( { code, signal, stdout, stderr } ) ) )
    return child
}

const wait_for_file = async path => {
    const deadline = Date.now() + 5_000
    while( !existsSync( path ) && Date.now() < deadline ) await delay( 20 )
    expect( existsSync( path ) ).toBe( true )
    return JSON.parse( readFileSync( path, `utf8` ) )
}

const alive = pid => {
    try {
        process.kill( pid, 0 ); return true
    } catch {
        return false
    }
}

describe( `Codex managed launch arguments`, () => {

    it( `keeps model, provider, effort, sandbox and feature overrides on the server`, () => {
        const plan = codex_launch_plan( [ `resume`, `thread-id`, `--model`, `custom-model`, `-c`, `model_provider="custom"`, `--config=model_reasoning_effort="low"`, `--sandbox`, `danger-full-access`, `--ask-for-approval`, `on-request`, `--disable`, `apps` ] )
        expect( plan.managed ).toBe( true )
        expect( plan.server_args ).toEqual( [ `app-server`, `-c`, `model_provider="custom"`, `-c`, `model_reasoning_effort="low"`, `-c`, `features.apps=false`, `-c`, `model="custom-model"`, `-c`, `sandbox_mode="danger-full-access"`, `-c`, `approval_policy="on-request"`, `-c`, `features.step_model_switching=true` ] )
    } )

    it( `supports attached short arguments and permission bypass`, () => {
        const { server_args } = codex_launch_plan( [ `-mcustom`, `-cmodel_reasoning_effort="medium"`, `--dangerously-bypass-approvals-and-sandbox` ] )
        expect( server_args ).toContain( `model="custom"` )
        expect( server_args ).toContain( `model_reasoning_effort="medium"` )
        expect( server_args ).toContain( `approval_policy="never"` )
        expect( server_args ).toContain( `sandbox_mode="danger-full-access"` )
    } )

    it( `does not turn noninteractive commands, help or explicit remote clients into managed sessions`, () => {
        for( const args of [ [ `exec`, `resume`, `--last` ], [ `-c`, `model="exec"`, `login`, `status` ], [ `--help` ], [ `resume`, `--help` ], [ `--remote`, `ws://localhost:1234` ] ] ) expect( codex_launch_plan( args ).managed ).toBe( false )
        expect( codex_launch_plan( [ `resume`, `--last` ] ).managed ).toBe( true )
        expect( codex_launch_plan( [ `fork`, `thread-id` ] ).managed ).toBe( true )
        expect( codex_launch_plan( [ `--`, `exec` ] ).managed ).toBe( true )
    } )

    it( `preserves profiles with an explicit compatibility warning`, () => {
        expect( codex_launch_plan( [ `-p`, `work` ] ) ).toMatchObject( { managed: false, warning: expect.stringContaining( `profiles` ) } )
    } )

} )

describe( `OpenCode managed launch arguments`, () => {

    it( `preserves inline settings and plugins while pinning a local endpoint`, () => {
        const plan = opencode_launch_plan( [ `--model`, `provider/model`, `--hostname=localhost`, `--port`, `43567`, `--session`, `session-id`, `--mdns` ], { OPENCODE_CONFIG_CONTENT: JSON.stringify( { model: `configured`, plugin: [ `existing-plugin` ], provider: { custom: {} } } ) } )
        expect( plan.managed ).toBe( true )
        expect( plan.port ).toBe( 43567 )
        expect( plan.tui_args ).toEqual( [ `--model`, `provider/model`, `--session`, `session-id` ] )
        const config = JSON.parse( plan.config_content )
        expect( config.model ).toBe( `configured` )
        expect( config.provider ).toEqual( { custom: {} } )
        expect( config.plugin[ 0 ] ).toBe( `existing-plugin` )
        expect( config.plugin[ 1 ] ).toMatch( /^file:\/\/.*\/opencode-plugin\.mjs$/ )
    } )

    it( `preserves pure mode, non-TUI commands, and custom nonlocal servers`, () => {
        for( const args of [ [ `run`, `hello` ], [ `--model`, `run`, `auth`, `list` ], [ `attach`, `http://localhost:4000` ], [ `--help` ], [ `--pure` ], [ `--hostname`, `0.0.0.0` ] ] ) expect( opencode_launch_plan( args, {} ).managed ).toBe( false )
        expect( opencode_launch_plan( [], { OPENCODE_PURE: `1` } ).managed ).toBe( false )
        expect( opencode_launch_plan( [ `--continue` ], {} ).managed ).toBe( true )
    } )

    it( `rejects invalid config rather than dropping user settings`, () => {
        expect( () => opencode_launch_plan( [], { OPENCODE_CONFIG_CONTENT: `not-json` } ) ).toThrow()
        expect( () => opencode_launch_plan( [], { OPENCODE_CONFIG_CONTENT: `{"plugin":"wrong"}` } ) ).toThrow( `plugin array` )
    } )

} )

describe( `managed launcher lifecycle`, () => {

    it( `keeps noisy background stderr out of a real terminal while preserving frontend output`, async () => {
        const files = fixture()
        const { code, stdout, stderr } = await run_fixture( { ...files, terminal: true }, [], { SERVER_NOISE: `1`, TUI_DIAGNOSTIC: `1` } ).result
        expect( code ).toBe( 0 )
        expect( stdout ).toContain( `frontend stderr; tty=true` )
        expect( stdout ).not.toContain( `background diagnostic` )
        expect( stdout ).not.toContain( `server diagnostic tail` )
        expect( stderr ).toBe( `` )
    }, 10_000 )

    it( `retains a bounded server diagnostic tail when startup fails`, async () => {
        const { code, stderr } = await run_fixture( fixture(), [], { SERVER_NOISE: `1`, SERVER_FAIL: `1` } ).result
        expect( code ).toBe( 1 )
        expect( stderr ).toContain( `before becoming ready` )
        expect( stderr ).toContain( `server diagnostic tail` )
        expect( stderr.length ).toBeLessThan( 17_000 )
    }, 10_000 )

    it( `defers completion capture warnings until the terminal frontend exits`, async () => {
        const files = fixture()
        writeFileSync( join( files.directory, `python3` ), `#!/bin/sh\nif [ "$2" = notify-command ]; then printf '[]'; exit 0; fi\nshift 3\nexec "$@"\n`, { mode: 0o755 } )
        const { code, stderr } = await run_fixture( { ...files, captured: true }, [], { PATH: `${ files.directory }:${ process.env.PATH }`, OBSERVER_FAIL: `1` } ).result
        expect( code ).toBe( 0 )
        expect( stderr ).toContain( `frontend finished` )
        expect( stderr ).toContain( `Codex completion capture failed: observer failure` )
        expect( stderr.indexOf( `frontend finished` ) ).toBeLessThan( stderr.indexOf( `Codex completion capture failed` ) )
    }, 10_000 )

    it( `preserves passthrough command stderr`, async () => {
        const { code, stderr } = await run_fixture( fixture(), [ `login`, `status` ], { TUI_DIAGNOSTIC: `1` } ).result
        expect( code ).toBe( 0 )
        expect( stderr ).toContain( `frontend stderr` )
    }, 10_000 )

    it( `retains completion capture around both actual Codex processes`, async () => {
        const files = fixture()
        writeFileSync( join( files.directory, `python3` ), `#!/bin/sh\nif [ "$2" = notify-command ]; then printf '[]'; exit 0; fi\nexport CAPTURE_SEEN="$1|$2|$3"\nshift 3\nexec "$@"\n`, { mode: 0o755 } )
        const { code } = await run_fixture( { ...files, captured: true }, [], { PATH: `${ files.directory }:${ process.env.PATH }` } ).result
        expect( code ).toBe( 0 )
        const server = await wait_for_file( join( files.directory, `server.json` ) )
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        expect( server.capture ).toBe( `/home/node/.babysit-capture/capture.py|launch|codex` )
        expect( tui.capture ).toBe( server.capture )
        expect( alive( server.pid ) ).toBe( false )
    }, 10_000 )

    it( `initializes the server before attaching and preserves TUI exit status`, async () => {
        const files = fixture()
        const { code } = await run_fixture( files, [ `resume`, `thread-id`, `--model`, `chosen` ], { TUI_STATUS: `23` } ).result
        expect( code ).toBe( 23 )
        const server = await wait_for_file( join( files.directory, `server.json` ) )
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        expect( server.endpoint ).toMatch( /^ws:\/\/127\.0\.0\.1:\d+$/ )
        expect( tui.endpoint ).toBe( server.endpoint )
        expect( server.agent ).toBe( `codex` )
        expect( tui.args ).toEqual( [ `--remote`, server.endpoint, `--cd`, process.cwd(), `resume`, `thread-id`, `--model`, `chosen`, `-c`, `features.step_model_switching=true` ] )
        expect( alive( server.pid ) ).toBe( false )
        expect( alive( tui.pid ) ).toBe( false )
    }, 10_000 )

    it( `preserves an explicitly chosen resume workspace`, async () => {
        const files = fixture()
        const { code } = await run_fixture( files, [ `resume`, `--last`, `--cd`, files.directory ] ).result
        expect( code ).toBe( 0 )
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        expect( tui.args.filter( value => value === `--cd` ) ).toHaveLength( 1 )
        expect( tui.args[ tui.args.indexOf( `--cd` ) + 1 ] ).toBe( files.directory )
    }, 10_000 )

    it( `does not launch the TUI when the server fails`, async () => {
        const files = fixture()
        const { code, stderr } = await run_fixture( files, [], { SERVER_FAIL: `1` } ).result
        expect( code ).toBe( 1 )
        expect( stderr ).toContain( `before becoming ready` )
        expect( existsSync( join( files.directory, `tui.json` ) ) ).toBe( false )
    }, 10_000 )

    it( `stops the TUI if its server dies`, async () => {
        const files = fixture()
        const { code, stderr } = await run_fixture( files, [], { SERVER_DIES: `1`, SERVER_NOISE: `1`, TUI_WAIT: `1` } ).result
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        expect( code ).toBe( 1 )
        expect( stderr ).toContain( `while its TUI was running` )
        expect( stderr ).toContain( `server diagnostic tail` )
        expect( stderr.length ).toBeLessThan( 17_000 )
        expect( alive( tui.pid ) ).toBe( false )
    }, 10_000 )

    it( `reaps a stubborn server after interruption`, async () => {
        const files = fixture()
        const child = run_fixture( files, [], { SERVER_STUBBORN: `1`, TUI_WAIT: `1` } )
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        const server = await wait_for_file( join( files.directory, `server.json` ) )
        child.kill( `SIGTERM` )
        expect( ( await child.result ).code ).toBe( 143 )
        expect( alive( server.pid ) ).toBe( false )
        expect( alive( tui.pid ) ).toBe( false )
    }, 10_000 )

    it( `passes helper commands through and removes inherited effort targeting`, async () => {
        const files = fixture()
        expect( ( await run_fixture( files, [ `login`, `status` ], { BABYSIT_EFFORT_ENDPOINT: `ws://parent:1`, BABYSIT_EFFORT_AGENT: `codex` } ).result ).code ).toBe( 0 )
        const tui = await wait_for_file( join( files.directory, `tui.json` ) )
        expect( tui.args ).toEqual( [ `login`, `status` ] )
        expect( tui.endpoint ).toBeUndefined()
        expect( existsSync( join( files.directory, `server.json` ) ) ).toBe( false )
    }, 10_000 )

    it( `stops tool descendants even when they created another process group`, async () => {
        const files = fixture()
        const child = run_fixture( files, [], { SERVER_TOOL: `1`, TUI_WAIT: `1` } )
        await wait_for_file( join( files.directory, `tui.json` ) )
        const tool = await wait_for_file( join( files.directory, `tool.json` ) )
        child.kill( `SIGTERM` )
        expect( ( await child.result ).code ).toBe( 143 )
        // An adopted child may await PID 1's reaper, but must no longer execute.
        if( existsSync( `/proc/${ tool.pid }/stat` ) ) expect( readFileSync( `/proc/${ tool.pid }/stat`, `utf8` ) ).toMatch( /\) Z / )
        else expect( alive( tool.pid ) ).toBe( false )
    }, 10_000 )

} )
