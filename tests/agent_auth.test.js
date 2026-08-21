import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import { SUPPORTED_AGENTS, get_agent } from '../src/agents/index.js'
import {
    answered_ok,
    build_docker_auth_check_command_args,
    build_docker_auth_check_cleanup_command_args,
    build_host_auth_args,
    build_host_auth_prompt,
    check_host_agent_authentication,
    confirm_continue_with_unauthenticated_agents,
    docker_auth_check_container_name,
    failed_agent_names,
    format_host_auth_status_message,
    format_utc_timestamp,
    last_nonempty_line,
    resolve_host_auth_context_files,
    resolve_host_auth_context_values,
    run_host_agent_auth_check,
    select_host_auth_check_agents,
    should_continue_with_unauthenticated_agents,
    unauthenticated_agent_names,
} from '../src/agents/auth.js'
import { OPENCODE_DEFAULT_MODEL, resolve_opencode_model } from '../src/agents/opencode.js'

const fake_spawn = ( { code = 0, stdout = `ok\n`, stderr = `` } = {}, on_spawn = () => {} ) => (
    cmd,
    args,
    options
) => {

    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}

    on_spawn( { cmd, args, options } )

    queueMicrotask( () => {
        if( stdout ) child.stdout.write( stdout )
        if( stderr ) child.stderr.write( stderr )
        child.emit( `close`, code )
    } )

    return child

}

const fake_hanging_spawn = ( on_kill = () => {} ) => () => {

    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => {
        on_kill( signal )
        return true
    }

    return child

}

const fake_sigterm_exit_spawn = ( on_kill = () => {} ) => () => {

    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = signal => {
        on_kill( signal )
        if( signal === `SIGTERM` ) queueMicrotask( () => child.emit( `close`, null ) )
        return true
    }

    return child

}

const fake_error_spawn = error => () => {

    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}

    queueMicrotask( () => child.emit( `error`, error ) )

    return child

}

const deferred = () => {

    let resolve
    const promise = new Promise( resolve_promise => {
        resolve = resolve_promise
    } )

    return { promise, resolve }

}

describe( `host agent auth checks`, () => {

    it( `builds the timestamped prompt from UTC time`, () => {
        const date = new Date( `2026-06-09T12:34:56.789Z` )

        expect( format_utc_timestamp( date ) ).toBe( `2026-06-09 12:34:56 UTC` )
        expect( build_host_auth_prompt( date ) ).toBe(
            `The current time is 2026-06-09 12:34:56 UTC. What do you think about that? Respond with just ok`
        )
    } )

    it( `declares prompt-level auth commands for every supported agent`, () => {
        const prompt = `Respond with just ok`

        expect( build_host_auth_args( get_agent( `claude` ), prompt ) )
            .toEqual( [ `-p`, prompt, `--no-session-persistence` ] )
        expect( build_host_auth_args( get_agent( `codex` ), prompt ) )
            .toEqual( [ `exec`, `--ephemeral`, `--skip-git-repo-check`, `--color`, `never`, prompt ] )
        expect( build_host_auth_args( get_agent( `gemini` ), prompt ) )
            .toEqual( [ `--skip-trust`, `-p`, prompt ] )
        expect( build_host_auth_args( get_agent( `opencode` ), prompt ) )
            .toEqual( [
                `run`,
                `--model`, OPENCODE_DEFAULT_MODEL,
                `--agent`, `babysit-auth`,
                prompt,
            ] )
    } )

    it( `pins OpenCode probes to the effective passthrough model`, () => {
        const args = [ `--model`, `anthropic/first`, `-m=openai/second` ]

        expect( resolve_opencode_model( args ) ).toBe( `openai/second` )
        expect( resolve_opencode_model( [ `--model=google/gemini-pro` ] ) )
            .toBe( `google/gemini-pro` )
        expect( resolve_opencode_model() ).toBe( OPENCODE_DEFAULT_MODEL )
        expect( build_host_auth_args( get_agent( `opencode` ), `hello`, { agent_args: args } ) )
            .toEqual( [
                `run`,
                `--model`, `openai/second`,
                `--agent`, `babysit-auth`,
                `hello`,
            ] )
        expect( resolve_host_auth_context_values( get_agent( `opencode` ), args ) ).toEqual( {
            model: `openai/second`,
            profile: `tool-free-v1`,
            route: `{}`,
        } )
    } )

    it( `pins OpenCode probes to the generated config profile`, async () => {
        let launch_options

        await run_host_agent_auth_check( get_agent( `opencode` ), {
            prompt: `hello`,
            prepare_launch: async options => {
                launch_options = options
                return {
                    command_args: [ `docker`, `start`, `-ai`, `probe-id` ],
                    pull_synced_files: async () => {},
                    abort: async () => {},
                }
            },
            spawn_fn: fake_spawn(),
            timeout_ms: 1_000,
        } )

        expect( launch_options.agent_command ).toEqual( [
            `env`,
            `-u`, `OPENCODE_CONFIG`,
            `-u`, `OPENCODE_CONFIG_CONTENT`,
            `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`,
            `opencode`,
            `run`,
            `--model`, OPENCODE_DEFAULT_MODEL,
            `--agent`, `babysit-auth`,
            `hello`,
        ] )
    } )

    it( `builds auth checks against the Babysit Docker image`, () => {
        const args = build_docker_auth_check_command_args( get_agent( `codex` ), {
            prompt: `hello`,
            workspace: `/tmp/project`,
            mode: { yolo: true },
            creds_mounts: [ { type: `env`, key: `CODEX_API_KEY`, value: `test-token` } ],
        } )

        expect( args.slice( 0, 3 ) ).toEqual( [ `docker`, `run`, `--rm` ] )
        expect( args ).not.toContain( `-it` )
        expect( args ).toContain( `CODEX_API_KEY=test-token` )
        expect( args ).toContain( `actuallymentor/babysit:latest` )
        expect( args.some( arg => arg.includes( `/tmp/project:/workspace` ) ) ).toBe( false )
        expect( args.some( arg => arg.includes( `/home/node/.agents` ) ) ).toBe( false )
        expect( args.some( arg => arg.includes( `/home/node/.codex/sessions` ) ) ).toBe( false )
        expect( args.slice( -7 ) ).toEqual( [
            `codex`,
            `exec`,
            `--ephemeral`,
            `--skip-git-repo-check`,
            `--color`,
            `never`,
            `hello`,
        ] )
    } )

    it( `keeps credentials but isolates host context when the flag is active`, () => {
        const args = build_docker_auth_check_command_args( get_agent( `claude` ), {
            prompt: `hello`,
            workspace: `/tmp/project`,
            mode: {
                yolo: true,
                ignore_host_agents_md: true,
            },
            creds_mounts: [ {
                type: `env`,
                key: `ANTHROPIC_API_KEY`,
                value: `test-token`,
            } ],
        } )

        expect( args ).toContain( `ANTHROPIC_API_KEY=test-token` )
        expect( args.some( arg => arg.endsWith( `:/home/node/.agents` ) ) ).toBe( false )
        expect( args.some( arg => arg.includes( `:/home/node/.claude/CLAUDE.md` ) ) ).toBe( false )
        expect( args.some( arg => arg.includes( `:/home/node/.claude/skills` ) ) ).toBe( false )
    } )

    it( `builds cleanup commands for Dockerized auth-check containers`, () => {
        const command_args = [
            `sudo`,
            `docker`,
            `run`,
            `--rm`,
            `--name`,
            `babysit-codex-123`,
            `actuallymentor/babysit:latest`,
            `codex`,
        ]

        expect( docker_auth_check_container_name( command_args ) ).toBe( `babysit-codex-123` )
        expect( build_docker_auth_check_cleanup_command_args( command_args ) )
            .toEqual( [ `sudo`, `docker`, `rm`, `-f`, `babysit-codex-123` ] )
        expect( build_docker_auth_check_cleanup_command_args( [ `docker`, `run`, `--rm` ] ) )
            .toBeNull()
    } )

    it( `formats the requested boot auth status message`, () => {
        expect( format_host_auth_status_message() )
            .toBe( `Checking agent auth status...` )
        expect( format_host_auth_status_message( [] ) )
            .toBe( `No agents configured for authentication checks; skipping authentication checks` )
    } )

    it( `tracks the effective babysitrc authentication context`, () => {

        expect( resolve_host_auth_context_files( {}, {
            env: {},
            babysit_rc_path: `/host/.babysitrc`,
            path_exists: () => true,
        } ) ).toEqual( { babysitrc: `/host/.babysitrc` } )

        expect( resolve_host_auth_context_files( {}, {
            env: { BABYSIT_HOST_BABYSITRC: `/outer/.babysitrc` },
            path_exists: () => false,
        } ) ).toEqual( { babysitrc: `/outer/.babysitrc` } )

        expect( resolve_host_auth_context_files( { ignore_host_agents_md: true }, {
            env: { BABYSIT_HOST_BABYSITRC: `/outer/.babysitrc` },
        } ) ).toEqual( {} )

    } )

    it( `tracks provider and account config used by each probe profile`, () => {

        const home_dir = mkdtempSync( join( tmpdir(), `babysit-auth-context-` ) )
        const rc_path = join( home_dir, `.babysitrc` )

        try {
            mkdirSync( join( home_dir, `.codex` ) )
            mkdirSync( join( home_dir, `.gemini` ) )
            writeFileSync( rc_path, `CUSTOM_API_KEY=test\n` )
            writeFileSync( join( home_dir, `.codex`, `config.toml` ), `model_provider = "custom"\n` )
            writeFileSync( join( home_dir, `.gemini`, `settings.json` ), `{}` )
            writeFileSync( join( home_dir, `.gemini`, `google_accounts.json` ), `{}` )

            expect( resolve_host_auth_context_files( {}, {
                agent: get_agent( `codex` ),
                env: {},
                home_dir,
                babysit_rc_path: rc_path,
            } ) ).toEqual( {
                babysitrc: rc_path,
                codex_config: join( home_dir, `.codex`, `config.toml` ),
            } )
            expect( resolve_host_auth_context_files( { ignore_host_agents_md: true }, {
                agent: get_agent( `gemini` ),
                env: {},
                home_dir,
            } ) ).toEqual( {
                gemini_settings: {
                    path: join( home_dir, `.gemini`, `settings.json` ),
                    transform: expect.any( Function ),
                },
                gemini_account: join( home_dir, `.gemini`, `google_accounts.json` ),
            } )
        } finally {
            rmSync( home_dir, { recursive: true, force: true } )
        }

    } )

    it( `selects configured host auth-check agents`, () => {
        const agents = select_host_auth_check_agents( {
            read_config: () => ( {
                auth_check_agents: [ `codex`, `gemini`, `missing` ],
            } ),
        } )

        expect( agents.map( agent => agent.name ) ).toEqual( [ `codex`, `gemini` ] )
    } )

    it( `runs a Dockerized agent auth command and treats exit zero as authenticated`, async () => {
        const calls = []
        const result = await run_host_agent_auth_check( get_agent( `claude` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( {}, call => calls.push( call ) ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( true )
        expect( result.status ).toBe( `authenticated` )
        expect( result.output ).toBe( `ok` )
        expect( calls[0].cmd ).toBe( `docker` )
        expect( calls[0].args ).toContain( `run` )
        expect( calls[0].args ).not.toContain( `-it` )
        expect( calls[0].args ).toContain( `actuallymentor/babysit:latest` )
        expect( calls[0].args.slice( -4 ) ).toEqual( [ `claude`, `-p`, `hello`, `--no-session-persistence` ] )
        expect( calls[0].options.env.NO_COLOR ).toBe( `1` )
    } )

    it( `marks a non-zero prompt run as unauthenticated`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `codex` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( { code: 1, stderr: `login required` } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `unauthenticated` )
        expect( result.reason ).toBe( `login required` )
    } )

    it( `pulls the probed agent credential before removing a staged auth container`, async () => {

        const calls = []
        const result = await run_host_agent_auth_check( get_agent( `codex` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn(),
            prepare_launch: async () => ( {
                command_args: [ `docker`, `start`, `-ai`, `probe-id` ],
                pull_synced_files: async options => calls.push( [ `pull`, options ] ),
                abort: async () => calls.push( [ `abort` ] ),
            } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( true )
        expect( result.status ).toBe( `authenticated` )
        expect( calls ).toEqual( [
            [ `pull`, { target: `/home/node/.codex/auth.json` } ],
            [ `abort` ],
        ] )

    } )

    it( `retains a staged auth container when the final credential pull fails`, async () => {

        const calls = []
        const result = await run_host_agent_auth_check( get_agent( `codex` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn(),
            prepare_launch: async () => ( {
                command_args: [ `docker`, `start`, `-ai`, `probe-id` ],
                container_id: `probe-id`,
                pull_synced_files: async () => {
                    calls.push( [ `pull` ] )
                    throw new Error( `docker copy unavailable` )
                },
                abort: async () => calls.push( [ `abort` ] ),
                retain: async options => {
                    calls.push( [ `retain`, options ] )
                    return `probe-id`
                },
                handoff: () => calls.push( [ `handoff` ] ),
            } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `docker copy unavailable` )
        expect( calls ).toEqual( [
            [ `pull` ],
            [ `retain`, { stop: false } ],
        ] )

    } )

    it( `requires the prompt response to include ok`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `gemini` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( { code: 0, stdout: `choose an auth method` } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `unauthenticated` )
        expect( result.reason ).toBe( `choose an auth method` )
    } )

    it( `classifies OpenCode's provider picker as unauthenticated`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            prepare_launch: async () => ( {
                command_args: [ `docker`, `run`, `--rm`, `--name`, `babysit-opencode-auth-picker-test` ],
                pull_synced_files: async () => {},
                abort: async () => {},
            } ),
            spawn_fn: fake_spawn( { code: 1, stderr: `Connect a provider` } ),
            timeout_ms: 1_000,
        } )

        expect( result.status ).toBe( `unauthenticated` )
        expect( result.reason ).toBe( `Connect a provider` )
    } )

    it( `reports model and tool errors as probe failures, not missing login`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            prepare_launch: async () => ( {
                command_args: [ `docker`, `run`, `--rm`, `--name`, `babysit-opencode-model-test` ],
                pull_synced_files: async () => {},
                abort: async () => {},
            } ),
            spawn_fn: fake_spawn( {
                code: 1,
                stderr: `Model does not support tool calls`,
            } ),
            timeout_ms: 1_000,
        } )

        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `Model does not support tool calls` )
    } )

    it( `checks the final non-empty response line for ok`, () => {
        expect( last_nonempty_line( `warning\n\nok\n` ) ).toBe( `ok` )
        expect( answered_ok( `warning\nok\n` ) ).toBe( true )
        expect( answered_ok( `looking ok at the time` ) ).toBe( false )
    } )

    it( `marks missing adapter auth metadata as failed`, async () => {
        const result = await run_host_agent_auth_check( { name: `missing`, bin: `missing` } )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `missing auth check command` )
    } )

    it( `marks spawn errors as failed`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `claude` ), {
            spawn_fn: fake_error_spawn( new Error( `not found` ) ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `not found` )
    } )

    it( `cancels Docker preparation with an explicit skipped result`, async () => {

        const controller = new AbortController()
        const preparing = deferred()
        const task = run_host_agent_auth_check( get_agent( `codex` ), {
            signal: controller.signal,
            prepare_launch: async ( options, { signal } ) => {
                expect( options.agent.name ).toBe( `codex` )
                expect( signal ).toBeInstanceOf( AbortSignal )
                expect( signal ).not.toBe( controller.signal )
                preparing.resolve()

                return new Promise( ( resolve, reject ) => {
                    signal.addEventListener( `abort`, () => reject( new Error( `preparation aborted` ) ), { once: true } )
                } )
            },
            spawn_fn: () => {
                throw new Error( `child must not start` )
            },
        } )

        await preparing.promise
        controller.abort( { code: `skip` } )

        await expect( task ).resolves.toEqual( {
            name: `codex`,
            status: `skipped`,
            authenticated: false,
            reason: `preparation aborted`,
        } )

    } )

    it( `applies the authentication deadline during Docker preparation`, async () => {

        const result = await run_host_agent_auth_check( get_agent( `codex` ), {
            timeout_ms: 1,
            prepare_launch: async ( _, { signal } ) => new Promise( ( _resolve, reject ) => {
                signal.addEventListener( `abort`, () => reject( new Error( `preparation aborted` ) ), { once: true } )
            } ),
        } )

        expect( result ).toEqual( {
            name: `codex`,
            status: `failed`,
            authenticated: false,
            reason: `timed out`,
        } )

    } )

    it( `cancels a running child and finalizes credentials before resolving`, async () => {

        const controller = new AbortController()
        const child_started = deferred()
        const signals = []
        const calls = []
        const child_spawn = fake_sigterm_exit_spawn( signal => signals.push( signal ) )
        const task = run_host_agent_auth_check( get_agent( `codex` ), {
            signal: controller.signal,
            prepare_launch: async () => ( {
                command_args: [ `docker`, `start`, `-ai`, `probe-id` ],
                pull_synced_files: async () => calls.push( `pull` ),
                abort: async () => calls.push( `abort` ),
            } ),
            spawn_fn: ( ...args ) => {
                child_started.resolve()
                return child_spawn( ...args )
            },
            kill_grace_ms: 1_000,
        } )

        await child_started.promise
        controller.abort( { code: `skip` } )
        const result = await task

        expect( result.status ).toBe( `skipped` )
        expect( result.reason ).toBe( `skipped by user` )
        expect( signals ).toEqual( [ `SIGTERM` ] )
        expect( calls ).toEqual( [ `pull`, `abort` ] )

    } )

    it( `waits for an in-flight final pull when cancellation arrives`, async () => {

        const controller = new AbortController()
        const pull_started = deferred()
        const release_pull = deferred()
        const calls = []
        const task = run_host_agent_auth_check( get_agent( `codex` ), {
            signal: controller.signal,
            spawn_fn: fake_spawn(),
            prepare_launch: async () => ( {
                command_args: [ `docker`, `start`, `-ai`, `probe-id` ],
                pull_synced_files: async () => {
                    calls.push( `pull` )
                    pull_started.resolve()
                    await release_pull.promise
                },
                abort: async () => calls.push( `abort` ),
            } ),
            kill_grace_ms: 1_000,
        } )

        await pull_started.promise
        controller.abort( { code: `skip` } )

        let settled = false
        task.finally( () => settled = true )
        await Promise.resolve()
        expect( settled ).toBe( false )

        release_pull.resolve()
        const result = await task

        expect( result.status ).toBe( `skipped` )
        expect( calls ).toEqual( [ `pull`, `abort` ] )

    } )

    it( `times out stuck auth checks and escalates after SIGTERM`, async () => {
        const signals = []
        const cleanups = []
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            prepare_launch: async () => ( {
                command_args: [ `docker`, `run`, `--rm`, `--name`, `babysit-opencode-timeout-test` ],
                pull_synced_files: async () => {},
                abort: async () => {},
            } ),
            spawn_fn: fake_hanging_spawn( signal => signals.push( signal ) ),
            cleanup_spawn_fn: ( cmd, args, options ) => {
                const child = new EventEmitter()
                child.unref = () => {}
                cleanups.push( { cmd, args, options } )
                return child
            },
            timeout_ms: 1,
            kill_grace_ms: 1,
        } )

        await new Promise( resolve => setTimeout( resolve, 20 ) )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `timed out` )
        expect( signals ).toEqual( [ `SIGTERM`, `SIGKILL` ] )
        expect( cleanups.length ).toBe( 1 )
        expect( cleanups[0].cmd ).toBe( `docker` )
        expect( cleanups[0].args.slice( 0, 2 ) ).toEqual( [ `rm`, `-f` ] )
        expect( cleanups[0].args[2].startsWith( `babysit-opencode-` ) ).toBe( true )
        expect( cleanups[0].options.env.NO_COLOR ).toBe( `1` )
    } )

    it( `does not escalate to SIGKILL when the child exits after SIGTERM`, async () => {
        const signals = []
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            prepare_launch: async () => ( {
                command_args: [ `docker`, `run`, `--rm`, `--name`, `babysit-opencode-sigterm-test` ],
                pull_synced_files: async () => {},
                abort: async () => {},
            } ),
            spawn_fn: fake_sigterm_exit_spawn( signal => signals.push( signal ) ),
            timeout_ms: 1,
            kill_grace_ms: 20,
        } )

        await new Promise( resolve => setTimeout( resolve, 30 ) )

        expect( result.authenticated ).toBe( false )
        expect( result.status ).toBe( `failed` )
        expect( result.reason ).toBe( `timed out` )
        expect( signals ).toEqual( [ `SIGTERM` ] )
    } )

    it( `checks all supported agents with the same prompt`, async () => {
        const calls = []
        const results = await check_host_agent_authentication( {
            agent_names: SUPPORTED_AGENTS,
            date: new Date( `2026-06-09T12:34:56Z` ),
            run_auth_check: async ( agent, { prompt } ) => {
                calls.push( { name: agent.name, prompt } )
                return { name: agent.name, authenticated: agent.name !== `codex` }
            },
        } )

        expect( calls.map( call => call.name ) ).toEqual( SUPPORTED_AGENTS )
        expect( calls.every( call => call.prompt.includes( `2026-06-09 12:34:56 UTC` ) ) ).toBe( true )
        expect( unauthenticated_agent_names( results ) ).toEqual( [ `codex` ] )
    } )

    it( `starts every host auth check before waiting for results`, async () => {
        const calls = []
        let release_checks
        const all_checks_started = new Promise( resolve => {
            release_checks = resolve
        } )

        const auth_check = check_host_agent_authentication( {
            agent_names: SUPPORTED_AGENTS,
            run_auth_check: async agent => {
                calls.push( agent.name )
                await all_checks_started
                return { name: agent.name, authenticated: true }
            },
        } )

        await Promise.resolve()

        expect( calls ).toEqual( SUPPORTED_AGENTS )

        release_checks()
        await expect( auth_check ).resolves.toEqual(
            SUPPORTED_AGENTS.map( name => ( { name, authenticated: true } ) )
        )
    } )

    it( `converts rejected auth runners into unauthenticated results`, async () => {
        const results = await check_host_agent_authentication( {
            agent_names: [ `claude` ],
            run_auth_check: async () => {
                throw new Error( `runner exploded` )
            },
        } )

        expect( results ).toEqual( [ {
            name: `claude`,
            status: `failed`,
            authenticated: false,
            reason: `runner exploded`,
        } ] )
    } )

    it( `does not classify skipped or cancelled checks as unauthenticated`, () => {
        const names = unauthenticated_agent_names( [
            { name: `codex`, status: `skipped`, authenticated: false },
            { name: `claude`, status: `cancelled`, authenticated: false },
            { name: `gemini`, status: `unauthenticated`, authenticated: false },
            { name: `opencode`, status: `failed`, authenticated: false },
            { name: `legacy`, authenticated: false },
        ] )

        expect( names ).toEqual( [ `gemini`, `legacy` ] )
        expect( failed_agent_names( [
            { name: `gemini`, status: `unauthenticated` },
            { name: `opencode`, status: `failed` },
        ] ) ).toEqual( [ `opencode` ] )
    } )

    it( `defaults the unauthenticated prompt to exit unless the user says no`, () => {
        expect( should_continue_with_unauthenticated_agents( `n` ) ).toBe( true )
        expect( should_continue_with_unauthenticated_agents( `no` ) ).toBe( true )
        expect( should_continue_with_unauthenticated_agents( `` ) ).toBe( false )
        expect( should_continue_with_unauthenticated_agents( `Y` ) ).toBe( false )
        expect( should_continue_with_unauthenticated_agents( `yes` ) ).toBe( false )
    } )

    it( `prints the requested unauthenticated-agent prompt`, async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        let rendered = ``

        input.isTTY = true
        output.on( `data`, chunk => {
            rendered += chunk.toString()
        } )

        const answer = confirm_continue_with_unauthenticated_agents( [ `claude`, `codex` ], { input, output } )
        queueMicrotask( () => input.write( `n\n` ) )

        await expect( answer ).resolves.toBe( true )
        expect( rendered ).toBe(
            [
                `Unauthenticated agents: claude, codex.`,
                `Run \`babysit doctor --auth\` to check authentication explicitly.`,
                `Exit? [Y/n] `,
            ].join( `\n` )
        )
    } )

    it( `separates probe failures from unauthenticated agents`, async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        let rendered = ``

        input.isTTY = true
        output.on( `data`, chunk => rendered += chunk.toString() )

        const answer = confirm_continue_with_unauthenticated_agents( [ `claude` ], {
            input,
            output,
            failed_names: [ `opencode` ],
        } )
        queueMicrotask( () => input.write( `n\n` ) )

        await expect( answer ).resolves.toBe( true )
        expect( rendered ).toContain( `Unauthenticated agents: claude.` )
        expect( rendered ).toContain( `Authentication checks failed: opencode.` )
    } )

    it( `defaults to exit instead of hanging when stdin is not a TTY`, async () => {
        const input = new PassThrough()
        const output = new PassThrough()
        let rendered = ``

        input.isTTY = false
        output.on( `data`, chunk => {
            rendered += chunk.toString()
        } )

        await expect(
            confirm_continue_with_unauthenticated_agents( [ `gemini` ], { input, output } )
        ).resolves.toBe( false )
        expect( rendered ).toBe(
            [
                `Unauthenticated agents: gemini.`,
                `Run \`babysit doctor --auth\` to check authentication explicitly.`,
                `Exit? [Y/n] \n`,
            ].join( `\n` )
        )
    } )

} )
