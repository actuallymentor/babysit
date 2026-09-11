#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname } from 'path'
import { createInterface } from 'readline'
import { spawn, spawnSync } from 'child_process'

const binary_name = process.argv[1] ? basename( process.argv[1] ) : `agent`
const agent_name = binary_name === `agy` ? `antigravity` : binary_name
const workspace = `/workspace`
const marker_log = `${ workspace }/e2e-fake-agent.log`
const agent_args = process.argv.slice( 2 )
const session_prefix_by_agent = {
    claude: `c1a`,
    codex: `c0d`,
    antigravity: `9e1`,
    opencode: `0ce`,
}
const startup_banner_by_agent = {
    claude: `Welcome to Claude Code v3`,
    codex: `OpenAI Codex\nmodel: loading\ndirectory: loading or /workspace`,
    antigravity: `Antigravity CLI`,
    opencode: `OpenCode loading`,
}
const composer_ready_by_agent = {
    antigravity: `Antigravity CLI\n>\n? for shortcuts`,
    claude: `Claude Code v3\n? for shortcuts`,
    codex: `OpenAI Codex\nmodel: fake\ndirectory: /workspace\n› Ask Codex to do anything`,
    opencode: `Ask anything...`,
}
const credential_paths = {
    claude: `/home/node/.claude/.credentials.json`,
    codex: `/home/node/.codex/auth.json`,
    antigravity: `/home/node/.gemini/antigravity-cli/antigravity-oauth-token`,
    opencode: `/home/node/.local/share/opencode/auth.json`,
}

// Dockerized fake agents often run as PID 1, so native ids need their own
// entropy or resume lookups can collide across agent sessions.
const session_prefix = session_prefix_by_agent[ agent_name ] || `000`
const random_session_bits = Math.floor( Math.random() * 0x1000000000 ).toString( 16 ).padStart( 9, `0` )
const session_tail = `${ session_prefix }${ random_session_bits }`
const resume_index = agent_args.findIndex( argument => [ `resume`, `--resume`, `--session`, `--conversation` ].includes( argument ) )
const resume_id = resume_index >= 0 ? agent_args[ resume_index + 1 ] : null
const session_id = resume_id && /^[a-zA-Z0-9_-]{1,256}$/.test( resume_id ) && !resume_id.startsWith( `-` )
    ? resume_id : `00000000-0000-4000-8000-${ session_tail }`

const ensure_parent = ( path ) => mkdirSync( dirname( path ), { recursive: true } )

const record = ( message ) => {
    try {
        appendFileSync( marker_log, `${ new Date().toISOString() } ${ message }\n` )
    } catch {
        // Sandbox mode can point /workspace at an image-local path. If logging
        // fails, stdout still carries the test signal.
    }
}

const write_marker = ( path, content ) => {
    try {
        ensure_parent( path )
        writeFileSync( path, content )
        console.log( `MARKER_WRITTEN ${ path }` )
        return true
    } catch ( e ) {
        console.log( `WRITE_FAILED ${ path } ${ e.code || e.message }` )
        return false
    }
}

const assert_all_credentials_present = () => {
    const missing = Object.entries( credential_paths )
        .filter( ( [ , path ] ) => !existsSync( path ) )
        .map( ( [ agent ] ) => agent )

    const result = missing.length ? `missing:${ missing.join( `,` ) }` : `ok`
    write_marker( `${ workspace }/e2e-all-creds-${ agent_name }.txt`, result )
    console.log( `ALL_CREDENTIALS_${ missing.length ? `MISSING` : `OK` } ${ result }` )
}

const rotate_credentials = () => {
    const codex_home = process.env.CODEX_HOME || `/home/node/.codex`
    const auth_path = `${ codex_home }/auth.json`
    const current = existsSync( auth_path ) ? readFileSync( auth_path, `utf8` ) : `{}`
    const rotated = JSON.stringify( {
        previous_length: current.length,
        refresh_token: `e2e-rotated-token`,
    } )

    write_marker( auth_path, rotated )
    console.log( `CREDENTIALS_ROTATED` )
}

const run_docker_candidate = ( command ) => {
    const result = spawnSync( command[0], command.slice( 1 ), {
        encoding: `utf8`,
        stdio: [ `ignore`, `pipe`, `pipe` ],
    } )

    if( result.status === 0 ) return { ok: true, result }

    return { ok: false, result }
}

const run_sibling_container = () => {
    const host_workspace = process.env.BABYSIT_HOST_WORKSPACE
    const sibling_image = process.env.BABYSIT_E2E_SIBLING_IMAGE || process.env.BABYSIT_DOCKER_IMAGE

    if( !host_workspace || !sibling_image ) {
        write_marker( `${ workspace }/e2e-docker-error.txt`, `missing host workspace or sibling image` )
        console.log( `DOCKER_SIBLING_FAILED missing-env` )
        return
    }

    const docker_args = [
        `docker`, `run`, `--rm`,
        `-v`, `${ host_workspace }:/host_workspace`,
        `--entrypoint`, `sh`,
        sibling_image,
        `-lc`,
        `printf sibling-ok > /host_workspace/e2e-sibling.txt`,
    ]
    const sudo_args = [ `sudo`, ...docker_args ]
    const attempts = []
    let success = null

    for( const candidate of [ docker_args, sudo_args ] ) {
        const attempt = run_docker_candidate( candidate )
        attempts.push( attempt )
        if( attempt.ok ) {
            success = attempt
            break
        }
    }

    if( success ) {
        write_marker( `${ workspace }/e2e-docker.txt`, `sibling-ok` )
        console.log( `DOCKER_SIBLING_OK` )
        return
    }

    const error = attempts.map( ( { result }, i ) => [
        `attempt ${ i + 1 } status=${ result.status }`,
        result.stdout,
        result.stderr,
    ].join( `\n` ) ).join( `\n---\n` )

    write_marker( `${ workspace }/e2e-docker-error.txt`, error )
    console.log( `DOCKER_SIBLING_FAILED` )
}

const handle_prompt = ( line ) => {
    record( `input ${ JSON.stringify( line ) }` )

    // Native /exit is local control input; it must not invoke a model turn.
    if( line.includes( `BABYSIT_E2E_EXIT` ) ) {
        console.log( `FAKE_AGENT_EXITING` )
        process.exit( 0 )
    }

    if( agent_name === `antigravity` ) {
        run_antigravity_hooks( `PreInvocation` )
        append_antigravity_step( `USER_EXPLICIT`, `USER_INPUT`, line )
        append_antigravity_step( `MODEL`, `PLANNER_RESPONSE`, `Completed: ${ line }` )
        run_antigravity_hooks( `Stop` )
    }

    const auto_prompt_agent = line.match( /BABYSIT_E2E_AUTO_PROMPT_([A-Z]+)/ )?.[1]?.toLowerCase()
    if( auto_prompt_agent ) {
        write_marker( `${ workspace }/e2e-auto-prompt-${ auto_prompt_agent }.txt`, line )
        console.log( `AUTO_PROMPT_OK ${ auto_prompt_agent }` )
    }

    if( line.includes( `BABYSIT_E2E_INITIAL_PROMPT` ) ) {
        write_marker( `${ workspace }/e2e-initial-prompt.txt`, line )
        console.log( `INITIAL_PROMPT_OK` )
    }

    if( line.includes( `BABYSIT_E2E_MANUAL_PROMPT` ) ) {
        write_marker( `${ workspace }/e2e-manual-prompt.txt`, line )
        console.log( `MANUAL_PROMPT_OK` )
    }

    if( line.includes( `BABYSIT_E2E_WRITE_ATTEMPT` ) ) {
        write_marker( `${ workspace }/e2e-write-attempt.txt`, line )
    }

    if( line.includes( `BABYSIT_E2E_SANDBOX_CHECK` ) ) {
        const visible = existsSync( `${ workspace }/e2e-host-sentinel.txt` )
        console.log( visible ? `SANDBOX_SENTINEL_VISIBLE` : `SANDBOX_SENTINEL_ABSENT` )
        write_marker( `${ workspace }/e2e-sandbox-result.txt`, visible ? `visible` : `absent` )
    }

    if( line.includes( `BABYSIT_E2E_NODE_MODULES_CHECK` ) ) {
        const leaked = existsSync( `${ workspace }/node_modules/host-sentinel.txt` )
        console.log( leaked ? `NODE_MODULES_LEAKED` : `NODE_MODULES_ISOLATED` )
        write_marker( `${ workspace }/e2e-node-modules.txt`, leaked ? `leaked` : `isolated` )
    }

    if( line.includes( `BABYSIT_E2E_CLONE_CHECK` ) ) {
        const boundaries = {
            clone_visible: existsSync( `${ workspace }/e2e-original-sentinel.txt` ),
            original_visible: existsSync( `/original/e2e-original-sentinel.txt` ),
        }

        write_marker( `${ workspace }/e2e-initial-prompt.txt`, line )
        write_marker( `${ workspace }/e2e-clone-boundaries.json`, JSON.stringify( boundaries ) )
        write_marker( `/original/e2e-explicit-original-write.txt`, `writable` )
    }

    if( line.includes( `BABYSIT_E2E_DOCKER` ) ) run_sibling_container()
    if( line.includes( `BABYSIT_E2E_ROTATE_CREDS` ) ) rotate_credentials()

}

if( process.argv.includes( `--version` ) ) {
    console.log( `${ agent_name } fake-e2e 1.0.0` )
    process.exit( 0 )
}

if( agent_name === `codex` && agent_args.includes( `app-server` ) ) {
    // The managed launcher requires a real WebSocket initialize handshake
    // before it starts the fake TUI. Bun is included in Babysit's base image.
    let notify = []
    for( const [ index, argument ] of agent_args.entries() ) {
        const assignment = [ `-c`, `--config` ].includes( argument ) ? agent_args[ index + 1 ] : argument.startsWith( `--config=` ) ? argument.slice( `--config=`.length ) : ``
        if( assignment?.startsWith( `notify=` ) ) notify = JSON.parse( assignment.slice( `notify=`.length ) )
    }
    const server = spawn( `bun`, [ `-e`, `
        const endpoint = new URL(process.env.BABYSIT_EFFORT_ENDPOINT)
        Bun.serve({
            hostname: endpoint.hostname,
            port: Number(endpoint.port),
            fetch(request, server) {
                if(server.upgrade(request)) return
                return new Response('WebSocket required', {status: 400})
            },
            websocket: {
                message(socket, data) {
                    const request = JSON.parse(data)
                    if(request.id === undefined) return
                    const result = request.method === 'config/read'
                        ? {config: {notify: JSON.parse(process.env.BABYSIT_E2E_NOTIFY)}}
                        : request.method === 'thread/loaded/list'
                            ? {data: []}
                            : {userAgent: 'babysit-e2e-fake-codex'}
                    socket.send(JSON.stringify({
                        id: request.id,
                        result,
                    }))
                },
            },
        })
    ` ], { stdio: `inherit`, env: { ...process.env, BABYSIT_E2E_NOTIFY: JSON.stringify( notify ) } } )
    for( const signal of [ `SIGINT`, `SIGTERM`, `SIGHUP` ] ) process.on( signal, () => server.kill( signal ) )
    server.on( `error`, error => {
        console.error( error.message )
        process.exit( 1 )
    } )
    server.on( `close`, code => process.exit( code || 0 ) )
    await new Promise( () => {} )
}

const is_auth_check = agent_args.includes( `-p` )
    || agent_args.includes( `--prompt` )
    || agent_args.includes( `--print` )
    || agent_args[0] === `exec`
    || agent_args[0] === `run`

if( is_auth_check ) {
    // Babysit's startup probes run inside the Docker image and use each
    // agent's headless prompt mode.
    // Real interactive E2E sessions do not pass these shapes at process start.
    console.log( `ok` )
    process.exit( 0 )
}

// Model native persistent state and identity publication, so recovery exercises
// its real transcript reader and monitor bridge without calling external APIs.
const transcript_paths = {
    codex: `/home/node/.codex/sessions/e2e/rollout-${ session_id }.jsonl`,
    claude: `/home/node/.claude/projects/-workspace/${ session_id }.jsonl`,
    antigravity: `/home/node/.gemini/antigravity-cli/brain/${ session_id }/.system_generated/logs/transcript_full.jsonl`,
    opencode: `/home/node/.local/share/opencode/storage/session/e2e/${ session_id }.json`,
}
const transcript = transcript_paths[ agent_name ]
if( transcript ) {
    ensure_parent( transcript )
    if( agent_name !== `antigravity` ) writeFileSync( transcript, JSON.stringify( agent_name === `codex`
        ? { type: `session_meta`, payload: { id: session_id, source: `cli` } }
        : { sessionId: session_id, id: session_id, type: `user`, projectHash: `e2e` } ) + `\n` )
}
// Antigravity emits its real hook payloads against native SQLite and JSONL
// state; use the installed capture bridge rather than forging its receipts.
let antigravity_step = transcript && existsSync( transcript ) && agent_name === `antigravity`
    ? readFileSync( transcript, `utf8` ).trim().split( `\n` ).filter( Boolean ).length : 0
const append_antigravity_step = ( source, type, content ) => {
    appendFileSync( transcript, JSON.stringify( { step_index: antigravity_step++, source, type, status: `DONE`, content, tool_calls: [] } ) + `\n` )
}
const run_antigravity_hooks = event => {
    const hooks_file = `/home/node/.gemini/config/hooks.json`
    if( !existsSync( hooks_file ) ) throw new Error( `Antigravity completion hooks missing` )
    const hooks = JSON.parse( readFileSync( hooks_file, `utf8` ) )
    const payload = {
        conversationId: session_id,
        transcriptPath: transcript,
        artifactDirectoryPath: `/home/node/.gemini/antigravity-cli/brain/${ session_id }`,
        workspacePaths: [ workspace ],
        modelName: `gemini-3.8-flash-medium`,
        initialNumSteps: antigravity_step,
        invocationNum: 0,
        ... event === `Stop` ? { executionNum: antigravity_step, terminationReason: `NO_TOOL_CALL`, error: ``, fullyIdle: true } : {} ,
    }
    for( const group of Object.values( hooks ) ) for( const handler of group[ event ] || [] ) {
        if( handler.type !== `command` ) continue
        const result = spawnSync( `sh`, [ `-c`, handler.command ], {
            input: JSON.stringify( payload ), encoding: `utf8`, timeout: ( handler.timeout || 5 ) * 1000,
        } )
        if( result.error || result.status !== 0 ) {
            const reason = result.error?.message || result.stderr?.trim() || result.signal || `exit ${ result.status }`
            throw new Error( `Antigravity ${ event } hook failed: ${ reason }` )
        }
    }
}
if( agent_name === `antigravity` ) {
    const database = `/home/node/.gemini/antigravity-cli/conversations/${ session_id }.db`
    ensure_parent( database )
    const result = spawnSync( `python3`, [ `-c`, `
import sqlite3, sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute('CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER)')
    db.execute('INSERT INTO trajectory_meta SELECT ?, ?, 4, 17 WHERE NOT EXISTS (SELECT 1 FROM trajectory_meta)', (sys.argv[2], sys.argv[2]))
    db.execute('CREATE TABLE IF NOT EXISTS steps (idx INTEGER)')
    db.execute('INSERT INTO steps SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM steps)')
`, database, session_id ], { encoding: `utf8` } )
    if( result.status !== 0 ) throw new Error( `Antigravity native state failed: ${ result.stderr }` )
    if( !existsSync( transcript ) ) append_antigravity_step( `USER_EXPLICIT`, `USER_INPUT`, `Fixture conversation` )
    run_antigravity_hooks( `PreInvocation` )
}
if( agent_name !== `antigravity` && process.env.BABYSIT_COMPLETION_FILE && process.env.BABYSIT_COMPLETION_LAUNCH_ID ) {
    const identity_path = `${ dirname( process.env.BABYSIT_COMPLETION_FILE ) }/identity.json`
    ensure_parent( identity_path )
    const identity = JSON.stringify( {
        version: 1,
        launch_id: process.env.BABYSIT_COMPLETION_LAUNCH_ID,
        agent: agent_name,
        session_id,
        captured_at: new Date().toISOString(),
    } )
    const roots = { claude: `/home/node/.claude/projects`, codex: `/home/node/.codex/sessions`,
        opencode: `/home/node/.local/share/opencode` }
    if( process.env.BABYSIT_RECOVERY_IDENTITY === `1` && roots[ agent_name ] ) {
        const mirror = `${ roots[ agent_name ] }/.babysit-identities/${ process.env.BABYSIT_COMPLETION_LAUNCH_ID }.json`
        ensure_parent( mirror )
        writeFileSync( mirror, identity )
    }
    writeFileSync( identity_path, identity )
}

console.log( startup_banner_by_agent[ agent_name ] || `${ agent_name } fake agent` )
console.log( `${ agent_name } fake agent starting` )
console.log( `session: ${ session_id }` )
record( `argv ${ JSON.stringify( agent_args ) }` )
assert_all_credentials_present()

if( resume_index >= 0 ) {
    write_marker( `${ workspace }/e2e-resume-args.txt`, JSON.stringify( agent_args ) )
}

const rl = createInterface( {
    input: process.stdin,
    output: process.stdout,
    terminal: true,
} )

let composer_ready = !composer_ready_by_agent[ agent_name ]

rl.on( `line`, line => {
    if( composer_ready ) handle_prompt( line )
    else record( `startup input ignored ${ JSON.stringify( line ) }` )
} )
rl.on( `close`, () => process.exit( 0 ) )

if( composer_ready ) {
    console.log( `FAKE_AGENT_READY` )
    record( `ready ${ session_id }` )
} else {
    setTimeout( () => {
        composer_ready = true
        // Full-screen TUIs repaint startup placeholders instead of retaining
        // them in the visible pane. Clear the fake splash so blocker checks
        // exercise the same current-screen semantics.
        process.stdout.write( `\x1b[2J\x1b[H` )
        console.log( composer_ready_by_agent[ agent_name ] )
        console.log( `${ agent_name } fake agent ready` )
        console.log( `session: ${ session_id }` )
        console.log( `FAKE_AGENT_READY` )
        record( `ready ${ session_id }` )
    }, 350 )
}
