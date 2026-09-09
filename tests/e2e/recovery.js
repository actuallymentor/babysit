#!/usr/bin/env node

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const exec_file = promisify( execFile )
const repo = fileURLToPath( new URL( `../../`, import.meta.url ) )
const root = mkdtempSync( join( repo, `.babysit-recovery-e2e-` ) )
const home = join( root, `home` )
const temporary = join( root, `tmp` )
const binaries = join( root, `bin` )
const run_id = `babysit-recovery-${ Date.now() }-${ process.pid }`
const image = process.env.BABYSIT_E2E_FAKE_IMAGE || `babysit:e2e-fake`
const all_agents = [ `codex`, `claude`, `gemini`, `opencode` ]
const agents = process.env.BABYSIT_E2E_RECOVERY_AGENTS?.split( `,` ) || all_agents
assert.ok( agents.length && agents.every( agent => all_agents.includes( agent ) ), `Unknown recovery fixture agent` )
const prompt = `You were interrupted. Check the current state, then continue unfinished work.`
const volumes = new Set()
const claude_transcripts = new Set()
const env = { ...process.env, HOME: home, CODEX_HOME: join( home, `.codex` ), TMPDIR: temporary,
    PATH: `${ binaries }:${ process.env.PATH }`, AGENT_AUTONOMY_MODE: `yolo`,
    BABYSIT_TMUX_SOCKET: run_id, BABYSIT_DOCKER_IMAGE: image, BABYSIT_E2E_RUN_ID: run_id }
delete env.BABYSIT_HOST_BABYSITRC

const run = async ( command, args, options = {} ) => {
    const { stdout } = await exec_file( command, args, { cwd: repo, env, timeout: 360_000, maxBuffer: 4 * 1024 * 1024, ...options } )
    return stdout.trim()
}
const docker = args => env.BABYSIT_DOCKER_USE_SUDO === `1` ? run( `sudo`, [ `-n`, `docker`, ...args ] ) : run( `docker`, args )
const tmux = args => run( `tmux`, [ `-L`, run_id, ...args ] )
const cli = ( args, cwd = root ) => run( process.execPath, [ join( repo, `src/index.js` ), ...args, ... args[ 0 ] === `recover` ? [ `--json` ] : []  ], { cwd } )
const read_sessions = () => {
    const directory = join( home, `.babysit/sessions` )
    return existsSync( directory ) ? readdirSync( directory ).filter( name => name.endsWith( `.json` ) )
        .map( name => JSON.parse( readFileSync( join( directory, name ), `utf8` ) ) ) : []
}
const current = workspace => read_sessions().filter( session => session.original_pwd === workspace && !session.superseded_by )
    .sort( ( left, right ) => right.started_at.localeCompare( left.started_at ) )[ 0 ]
const wait_for = async ( label, check, timeout = 30_000 ) => {
    const deadline = Date.now() + timeout
    while( Date.now() < deadline ) {
        const result = await check()
        if( result ) return result
        await delay( 150 )
    }
    throw new Error( `Timed out: ${ label }` )
}
const input = async ( session, text ) => {
    await tmux( [ `send-keys`, `-t`, session.tmux_session, `-l`, text ] )
    await tmux( [ `send-keys`, `-t`, session.tmux_session, `Enter` ] )
}
const messages = workspace => {
    const file = join( workspace, `e2e-fake-agent.log` )
    return existsSync( file ) ? readFileSync( file, `utf8` ).split( `\n` ).filter( line => line.includes( `input ${ JSON.stringify( prompt ) }` ) ).length : 0
}
const kill_monitor = async session => {
    const command = await run( `ps`, [ `-ww`, `-p`, String( session.monitor_pid ), `-o`, `args=` ] )
    assert.ok( command.includes( session.monitor_token ), `only signal our exact monitor` )
    process.kill( session.monitor_pid, `SIGKILL` )
    await wait_for( `monitor killed`, async () => {
        try {
            return !( await run( `ps`, [ `-ww`, `-p`, String( session.monitor_pid ), `-o`, `args=` ] ) ).includes( session.monitor_token )
        } catch {
            return true
        }
    } )
}
const crash = async session => {
    // Kill the monitor first: this simulates loss of all volatile processes
    // without giving an observer a chance to interpret the exit as graceful.
    await kill_monitor( session )
    await docker( [ `rm`, `-f`, session.container_id ] )
    await tmux( [ `kill-session`, `-t`, session.tmux_session ] ).catch( () => {} )
}

try {
    for( const directory of [ home, temporary, binaries ] ) mkdirSync( directory, { recursive: true } )
    const credentials = [ `.claude/.credentials.json`, `.codex/auth.json`, `.gemini/oauth_creds.json`, `.local/share/opencode/auth.json` ]
    for( const file of credentials ) {
        mkdirSync( join( home, file, `..` ), { recursive: true } )
        writeFileSync( join( home, file ), JSON.stringify( { refresh_token: `isolated-recovery-fixture` } ) )
    }
    for( const agent of all_agents ) symlinkSync( join( repo, `tests/e2e/assets/fake-agent.mjs` ), join( binaries, agent ) )
    await docker( [ `image`, `inspect`, image ] )
    await tmux( [ `-V` ] )

    for( const agent of agents ) {
        const workspace = join( root, agent )
        mkdirSync( workspace )
        writeFileSync( join( workspace, `babysit.yaml` ), `config:\n    initial_prompt: ""\nbabysit: []\n` )
        await cli( [ agent, `--yolo` ], workspace )
        let session = await wait_for( `${ agent } durable native identity`, () => {
            const candidate = current( workspace )
            return candidate?.agent_session_id_source === `structured` && candidate.monitor_pid && candidate
        } )
        const mounts = JSON.parse( await docker( [ `inspect`, `--format`, `{{json .Mounts}}`, session.container_id ] ) )
        mounts.filter( mount => mount.Type === `volume` && !mount.Name.startsWith( `babysit-claude-` ) ).forEach( mount => volumes.add( mount.Name ) )
        assert.equal( session.expected_open, true )
        const native_id = session.agent_session_id
        if( agent === `claude` ) claude_transcripts.add( native_id )

        if( agent === `codex` ) {
            await kill_monitor( session )
            await cli( [ `recover`, session.babysit_id ] )
            session = await wait_for( `surviving session monitor repair`, () => {
                const repaired = current( workspace )
                return repaired.monitor_pid !== session.monitor_pid && repaired
            } )
            assert.equal( session.agent_session_id, native_id )
            assert.equal( messages( workspace ), 0, `monitor repair must not interrupt a surviving agent` )
            console.log( `PASS recover repairs only the killed monitor` )
        }

        await crash( session )
        const count = read_sessions().length
        await cli( [ `recover`, session.babysit_id, `--dry-run` ] )
        assert.equal( read_sessions().length, count, `dry-run must not launch sessions` )
        assert.equal( current( workspace ).babysit_id, session.babysit_id )

        if( agent === `opencode` ) {
            const attempts = await Promise.allSettled( [ cli( [ `recover`, session.babysit_id ] ), cli( [ `recover`, session.babysit_id ] ) ] )
            assert.ok( attempts.some( attempt => attempt.status === `fulfilled` ), `concurrent recovery did not succeed` )
            assert.equal( read_sessions().length, count + 1, `concurrent recovery duplicated a launch` )
        } else await cli( [ `recover`, session.babysit_id ] )
        const recovered = await wait_for( `${ agent } recovery and continuation`, () => {
            const candidate = current( workspace )
            return candidate.babysit_id !== session.babysit_id && messages( workspace ) === 1 && candidate
        } )
        assert.equal( recovered.agent_session_id, native_id, `resume must preserve the exact native conversation` )
        assert.equal( recovered.expected_open, true )
        const replayed_args = JSON.parse( readFileSync( join( workspace, `e2e-resume-args.txt` ), `utf8` ) )
        assert.ok( replayed_args.includes( native_id ), `native CLI did not receive the exact conversation ID` )
        const after = read_sessions().length
        await cli( [ `recover`, recovered.babysit_id ] )
        assert.equal( read_sessions().length, after, `repeated recover duplicated a launch` )
        assert.equal( messages( workspace ), 1, `repeated recover duplicated continuation` )
        console.log( `PASS ${ agent }: crash, dry-run, exact resume, one continuation, repeated recovery` )
        session = current( workspace )

        if( agent === `codex` ) {
            await crash( session )
            await cli( [ `recover`, session.babysit_id, `--no-continue` ] )
            const previous = session
            session = await wait_for( `no-continue recovery`, () => {
                const candidate = current( workspace )
                return candidate.babysit_id !== previous.babysit_id && candidate.monitor_pid && candidate
            } )
            assert.equal( messages( workspace ), 1 )
            assert.equal( session.continuation, `skipped` )
            console.log( `PASS --no-continue preserves the message count` )
        }
        if( agent === `opencode` ) {
            await kill_monitor( session )
            await input( session, `BABYSIT_E2E_EXIT` )
            await wait_for( `native exit without monitor`, async () => {
                try {
                    await tmux( [ `has-session`, `-t`, session.tmux_session ] )
                    return false
                } catch {
                    return true
                }
            } )
            assert.equal( current( workspace ).expected_open, true, `no live monitor should have retired this session` )
            await cli( [ `recover`, session.babysit_id ] )
            assert.equal( current( workspace ).babysit_id, session.babysit_id, `durable clean receipt must prevent relaunch` )
            console.log( `PASS durable native exit is recovered after monitor loss` )
        } else if( [ `claude`, `gemini` ].includes( agent ) ) await input( session, `BABYSIT_E2E_EXIT` )
        else await cli( [ `close`, session.babysit_id ] )
        await wait_for( `${ agent } graceful retirement`, () => current( workspace ).expected_open === false )
        const retired_count = read_sessions().length
        await cli( [ `recover` ] )
        assert.equal( read_sessions().length, retired_count, `retired conversation recovered again` )
        await wait_for( `${ agent } container cleanup`, async () => {
            try {
                await docker( [ `inspect`, session.container_id ] )
                return false
            } catch {
                return true
            }
        } )
        console.log( `PASS ${ agent }: intentional closure stays closed` )
    }
    console.log( `Recovery E2E passed` )
} finally {
    for( const session of read_sessions() ) {
        if( !session.monitor_pid || !session.monitor_token ) continue
        try {
            const command = await run( `ps`, [ `-ww`, `-p`, String( session.monitor_pid ), `-o`, `args=` ] )
            if( command.includes( session.monitor_token ) ) process.kill( session.monitor_pid, `SIGTERM` )
        } catch { /* Already stopped. */ }
    }
    await tmux( [ `kill-server` ] ).catch( () => {} )
    const containers = await docker( [ `ps`, `-aq`, `--filter`, `label=babysit.e2e_run=${ run_id }` ] ).catch( () => `` )
    if( containers ) await docker( [ `rm`, `-f`, ...containers.split( /\s+/ ) ] )
    // Claude's volumes are shared with ordinary sessions. Delete only our
    // random transcript IDs; never remove those shared volumes themselves.
    if( claude_transcripts.size ) await docker( [ `run`, `--rm`, `--network`, `none`, `--user`, `0`,
        `-v`, `babysit-claude-projects:/state`, `--entrypoint`, `rm`, image, `-f`,
        ...[ ...claude_transcripts ].map( id => `/state/-workspace/${ id }.jsonl` ),
        ...read_sessions().filter( session => session.agent === `claude` && session.completion_capture?.launch_id )
            .flatMap( session => [ `/state/.babysit-identities/${ session.completion_capture.launch_id }.json`, `/state/.babysit-identities/${ session.completion_capture.launch_id }.exit.json` ] ) ] )
    if( volumes.size ) await docker( [ `volume`, `rm`, ...volumes ] ).catch( () => {} )
    if( process.env.BABYSIT_E2E_KEEP_ARTIFACTS === `1` ) console.log( `Recovery artifacts: ${ root }` )
    else rmSync( root, { recursive: true, force: true } )
}
