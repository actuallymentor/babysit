#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname } from 'path'
import { createInterface } from 'readline'
import { spawnSync } from 'child_process'

const agent_name = process.argv[1] ? basename( process.argv[1] ) : `agent`
const workspace = `/workspace`
const marker_log = `${ workspace }/e2e-fake-agent.log`
const agent_args = process.argv.slice( 2 )
const session_prefix_by_agent = {
    claude: `c1a`,
    codex: `c0d`,
    gemini: `9e1`,
    opencode: `0ce`,
}
const startup_banner_by_agent = {
    claude: `Welcome to Claude Code v3`,
    codex: `OpenAI Codex\nmodel: loading\ndirectory: loading or /workspace`,
    gemini: `Gemini CLI`,
    opencode: `OpenCode loading`,
}
const composer_ready_by_agent = {
    claude: `Claude Code v3\n? for shortcuts`,
    codex: `OpenAI Codex\nmodel: fake\ndirectory: /workspace\n? for shortcuts`,
    opencode: `Ask anything...`,
}
const credential_paths = {
    claude: `/home/node/.claude/.credentials.json`,
    codex: `/home/node/.codex/auth.json`,
    gemini: `/home/node/.gemini/oauth_creds.json`,
    opencode: `/home/node/.local/share/opencode/auth.json`,
}

// Dockerized fake agents often run as PID 1, so native ids need their own
// entropy or resume lookups can collide across agent sessions.
const session_prefix = session_prefix_by_agent[ agent_name ] || `000`
const random_session_bits = Math.floor( Math.random() * 0x1000000000 ).toString( 16 ).padStart( 9, `0` )
const session_tail = `${ session_prefix }${ random_session_bits }`
const session_id = `00000000-0000-4000-8000-${ session_tail }`

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

    if( line.includes( `BABYSIT_E2E_DOCKER` ) ) run_sibling_container()
    if( line.includes( `BABYSIT_E2E_ROTATE_CREDS` ) ) rotate_credentials()

    if( line.includes( `BABYSIT_E2E_EXIT` ) ) {
        console.log( `FAKE_AGENT_EXITING` )
        process.exit( 0 )
    }
}

if( process.argv.includes( `--version` ) ) {
    console.log( `${ agent_name } fake-e2e 1.0.0` )
    process.exit( 0 )
}

const is_auth_check = agent_args.includes( `-p` )
    || agent_args.includes( `--prompt` )
    || agent_args[0] === `exec`
    || agent_args[0] === `run`

if( is_auth_check ) {
    // Babysit's startup probes run inside the Docker image and use each
    // agent's headless prompt mode.
    // Real interactive E2E sessions do not pass these shapes at process start.
    console.log( `ok` )
    process.exit( 0 )
}

console.log( startup_banner_by_agent[ agent_name ] || `${ agent_name } fake agent` )
console.log( `${ agent_name } fake agent starting` )
console.log( `session: ${ session_id }` )
record( `argv ${ JSON.stringify( agent_args ) }` )
assert_all_credentials_present()

if( agent_args.includes( `resume` ) ) {
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
