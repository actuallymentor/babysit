import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'events'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'

import { SUPPORTED_AGENTS, get_agent } from '../src/agents/index.js'
import {
    answered_ok,
    build_host_auth_args,
    build_host_auth_prompt,
    check_host_agent_authentication,
    confirm_continue_with_unauthenticated_agents,
    format_host_auth_status_message,
    format_utc_timestamp,
    get_host_auth_check_decision,
    get_recent_host_credential_file_evidence,
    is_recent_host_auth_timestamp,
    last_nonempty_line,
    read_host_auth_cache,
    record_host_auth_successes,
    run_host_agent_auth_check,
    select_host_auth_check_agents,
    should_continue_with_unauthenticated_agents,
    unauthenticated_agent_names,
} from '../src/agents/auth.js'

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
            .toEqual( [ `run`, prompt ] )
    } )

    it( `formats the requested boot auth status message`, () => {
        expect( format_host_auth_status_message() )
            .toBe( `Checking agent auth status...` )
        expect( format_host_auth_status_message( [] ) )
            .toBe( `No recent host agent authentications found; skipping authentication checks` )
    } )

    it( `records successful host auth checks without credential content`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-auth-cache-` ) )
        const cache_path = join( dir, `host-auth-cache.json` )
        const date = new Date( `2026-06-12T10:00:00Z` )

        try {
            const cache = record_host_auth_successes( [ `codex` ], { date, cache_path } )
            const raw = readFileSync( cache_path, `utf-8` )

            expect( cache.agents.codex.authenticated_at ).toBe( `2026-06-12T10:00:00.000Z` )
            expect( raw ).not.toContain( `token` )
            expect( read_host_auth_cache( { cache_path } ) ).toEqual( cache )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }
    } )

    it( `treats host auth cache writes as best effort`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-auth-cache-blocked-` ) )
        const date = new Date( `2026-06-12T10:00:00Z` )

        try {
            const cache = record_host_auth_successes( [ `claude` ], { date, cache_path: dir } )

            expect( cache.agents.claude.authenticated_at ).toBe( `2026-06-12T10:00:00.000Z` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }
    } )

    it( `detects recent timestamps inside the seven day auth window`, () => {
        const date = new Date( `2026-06-12T10:00:00Z` )

        expect( is_recent_host_auth_timestamp( `2026-06-06T10:00:00Z`, { date } ) ).toBe( true )
        expect( is_recent_host_auth_timestamp( `2026-06-04T10:00:00Z`, { date } ) ).toBe( false )
        expect( is_recent_host_auth_timestamp( `not a date`, { date } ) ).toBe( false )
    } )

    it( `uses stat metadata for recent credential file evidence`, () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-auth-evidence-` ) )
        const recent_path = join( dir, `recent-token.json` )
        const stale_path = join( dir, `stale-token.json` )
        const date = new Date( `2026-06-12T10:00:00Z` )

        try {
            writeFileSync( recent_path, `do not read me` )
            writeFileSync( stale_path, `do not read me` )
            utimesSync( recent_path, date, new Date( `2026-06-10T10:00:00Z` ) )
            utimesSync( stale_path, date, new Date( `2026-05-01T10:00:00Z` ) )

            const recent_agent = {
                name: `recent`,
                credentials: { linux: { file: recent_path } },
            }
            const stale_agent = {
                name: `stale`,
                credentials: { linux: { file: stale_path } },
            }

            expect(
                get_recent_host_credential_file_evidence( recent_agent, { date, platform: `linux` } ).recent
            ).toBe( true )
            expect(
                get_recent_host_credential_file_evidence( stale_agent, { date, platform: `linux` } ).recent
            ).toBe( false )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }
    } )

    it( `checks active agents and inactive agents with recent auth evidence`, () => {
        const date = new Date( `2100-01-01T00:00:00Z` )
        const cache = {
            agents: {
                gemini: { authenticated_at: `2100-01-01T00:00:00.000Z` },
            },
        }

        expect(
            get_host_auth_check_decision( get_agent( `codex` ), {
                active_agent_name: `codex`,
                cache: { agents: {} },
                date,
                env: {},
                platform: `linux`,
                recency_ms: 1,
            } )
        ).toMatchObject( { should_check: true, reason: `active agent` } )

        expect(
            get_host_auth_check_decision( get_agent( `gemini` ), {
                cache,
                date,
                env: {},
                platform: `linux`,
                recency_ms: 1,
            } )
        ).toMatchObject( { should_check: true, reason: `recent successful auth check` } )

        expect(
            get_host_auth_check_decision( {
                name: `fake`,
                credentials: { linux: { env_key: `FAKE_AGENT_TOKEN` } },
            }, {
                date,
                env: { FAKE_AGENT_TOKEN: `present` },
                platform: `linux`,
                recency_ms: 1,
            } )
        ).toMatchObject( { should_check: true, reason: `auth environment variable present` } )

        expect(
            get_host_auth_check_decision( get_agent( `claude` ), {
                cache: { agents: {} },
                date,
                env: {},
                platform: `linux`,
                recency_ms: 1,
            } )
        ).toMatchObject( { should_check: false, reason: `no recent auth evidence` } )
    } )

    it( `selects only active or recently authenticated host agents`, () => {
        const date = new Date( `2100-01-01T00:00:00Z` )
        const agents = select_host_auth_check_agents( {
            agent_names: [ `claude`, `codex`, `gemini` ],
            active_agent_name: `codex`,
            date,
            read_cache: () => ( {
                agents: {
                    gemini: { authenticated_at: `2100-01-01T00:00:00.000Z` },
                },
            } ),
            env: {},
            platform: `linux`,
            recency_ms: 1,
        } )

        expect( agents.map( agent => agent.name ) ).toEqual( [ `codex`, `gemini` ] )
    } )

    it( `runs an agent auth command and treats exit zero as authenticated`, async () => {
        const calls = []
        const result = await run_host_agent_auth_check( get_agent( `claude` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( {}, call => calls.push( call ) ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( true )
        expect( result.output ).toBe( `ok` )
        expect( calls[0].cmd ).toBe( `claude` )
        expect( calls[0].args ).toEqual( [ `-p`, `hello`, `--no-session-persistence` ] )
        expect( calls[0].options.env.NO_COLOR ).toBe( `1` )
    } )

    it( `marks a non-zero prompt run as unauthenticated`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `codex` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( { code: 1, stderr: `login required` } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `login required` )
    } )

    it( `requires the prompt response to include ok`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `gemini` ), {
            prompt: `hello`,
            spawn_fn: fake_spawn( { code: 0, stdout: `choose an auth method` } ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `choose an auth method` )
    } )

    it( `checks the final non-empty response line for ok`, () => {
        expect( last_nonempty_line( `warning\n\nok\n` ) ).toBe( `ok` )
        expect( answered_ok( `warning\nok\n` ) ).toBe( true )
        expect( answered_ok( `looking ok at the time` ) ).toBe( false )
    } )

    it( `marks missing adapter auth metadata as unauthenticated`, async () => {
        const result = await run_host_agent_auth_check( { name: `missing`, bin: `missing` } )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `missing auth check command` )
    } )

    it( `marks spawn errors as unauthenticated`, async () => {
        const result = await run_host_agent_auth_check( get_agent( `claude` ), {
            spawn_fn: fake_error_spawn( new Error( `not found` ) ),
            timeout_ms: 1_000,
        } )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `not found` )
    } )

    it( `times out stuck auth checks and escalates after SIGTERM`, async () => {
        const signals = []
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            spawn_fn: fake_hanging_spawn( signal => signals.push( signal ) ),
            timeout_ms: 1,
            kill_grace_ms: 1,
        } )

        await new Promise( resolve => setTimeout( resolve, 20 ) )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `timed out` )
        expect( signals ).toEqual( [ `SIGTERM`, `SIGKILL` ] )
    } )

    it( `does not escalate to SIGKILL when the child exits after SIGTERM`, async () => {
        const signals = []
        const result = await run_host_agent_auth_check( get_agent( `opencode` ), {
            spawn_fn: fake_sigterm_exit_spawn( signal => signals.push( signal ) ),
            timeout_ms: 1,
            kill_grace_ms: 20,
        } )

        await new Promise( resolve => setTimeout( resolve, 30 ) )

        expect( result.authenticated ).toBe( false )
        expect( result.reason ).toBe( `timed out` )
        expect( signals ).toEqual( [ `SIGTERM` ] )
    } )

    it( `checks all supported agents with the same prompt`, async () => {
        const calls = []
        const recorded = []
        const results = await check_host_agent_authentication( {
            date: new Date( `2026-06-09T12:34:56Z` ),
            filter_by_recent_auth_evidence: false,
            run_auth_check: async ( agent, { prompt } ) => {
                calls.push( { name: agent.name, prompt } )
                return { name: agent.name, authenticated: agent.name !== `codex` }
            },
            record_auth_successes: names => recorded.push( names ),
        } )

        expect( calls.map( call => call.name ) ).toEqual( SUPPORTED_AGENTS )
        expect( calls.every( call => call.prompt.includes( `2026-06-09 12:34:56 UTC` ) ) ).toBe( true )
        expect( unauthenticated_agent_names( results ) ).toEqual( [ `codex` ] )
        expect( recorded ).toEqual( [ [ `claude`, `gemini`, `opencode` ] ] )
    } )

    it( `starts every host auth check before waiting for results`, async () => {
        const calls = []
        let release_checks
        const all_checks_started = new Promise( resolve => {
            release_checks = resolve
        } )

        const auth_check = check_host_agent_authentication( {
            filter_by_recent_auth_evidence: false,
            run_auth_check: async agent => {
                calls.push( agent.name )
                await all_checks_started
                return { name: agent.name, authenticated: true }
            },
            record_auth_successes: () => {},
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
            filter_by_recent_auth_evidence: false,
            run_auth_check: async () => {
                throw new Error( `runner exploded` )
            },
        } )

        expect( results ).toEqual( [ {
            name: `claude`,
            authenticated: false,
            reason: `runner exploded`,
        } ] )
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
        expect( rendered ).toBe( `Unauthenticated agents: claude, codex. Exit? [Y/n] ` )
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
        expect( rendered ).toBe( `Unauthenticated agents: gemini. Exit? [Y/n] \n` )
    } )

} )
