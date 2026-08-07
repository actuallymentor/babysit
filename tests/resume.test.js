import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
    cmd_resume,
    is_resume_listing,
    merge_resume_flags,
    print_resumable_sessions_table,
    resolve_resume_target,
} from '../src/cli/resume.js'
import {
    resolve_agent_resume_target,
    resolve_session_display_name,
    resolve_stored_agent_resume_session,
    should_ignore_host_agent_context,
    should_send_initial_prompt,
} from '../src/cli/start.js'
import { generate_session_id } from '../src/sessions/store.js'

// Build realistic metadata without touching the developer's session registry.
const make_session = ( pwd ) => {

    const id = generate_session_id()
    return {
        babysit_id: id,
        agent: `claude`,
        agent_session_id: null,
        // Pretend the original session's tmux name died so the resume path
        // takes the "restart with resume flag" branch. The branch chdirs to
        // session.pwd before delegating to cmd_start.
        tmux_session: `babysit_dead_${ id }`,
        pwd,
        modifiers: [ `yolo` ],
        creds_tmpfile: null,
        started_at: new Date().toISOString(),
    }

}

const capture_console = async ( fn ) => {

    const original_log = console.log
    const lines = []

    console.log = ( line = `` ) => lines.push( String( line ) )

    try {
        await fn()
    } finally {
        console.log = original_log
    }

    return lines.join( `\n` )

}

describe( `cmd_resume session listing`, () => {

    const sessions = [
        {
            babysit_id: `20260804-120000-c0de`,
            name: `session registry`,
            agent: `codex`,
            agent_session_id: `019fcd12-c0de-7000-8000-000000000001`,
            pwd: `/workspace/codex-project`,
            started_at: `2026-08-04T12:00:00.000Z`,
        },
        {
            babysit_id: `20260803-120000-c1a0`,
            name: null,
            agent: `claude`,
            agent_session_id: `019fc7ec-c1a0-7000-8000-000000000002`,
            pwd: `/workspace/claude-project`,
            started_at: `2026-08-03T12:00:00.000Z`,
        },
        {
            babysit_id: `20260802-120000-babe`,
            name: null,
            agent: `codex`,
            agent_session_id: null,
            pwd: `/workspace/legacy-project`,
            started_at: `2026-08-02T12:00:00.000Z`,
        },
    ]

    it( `lists Babysit, Codex, and Claude ids when no selector is provided`, async () => {

        let rendered_sessions = null
        let start_called = false

        await cmd_resume( { session_id: null }, {
            list_stored_sessions_fn: () => sessions,
            print_sessions: value => {
                rendered_sessions = value
            },
            start: async () => {
                start_called = true
            },
        } )

        expect( rendered_sessions ).toBe( sessions )
        expect( start_called ).toBe( false )

    } )

    it( `does not mistake an explicit-agent resume for a local history listing`, () => {

        expect( is_resume_listing( {
            verb: `resume`,
            agent: null,
            session_id: null,
        } ) ).toBe( true )
        expect( is_resume_listing( {
            verb: `resume`,
            agent: `claude`,
            session_id: null,
        } ) ).toBe( false )
        expect( is_resume_listing( {
            verb: `resume`,
            agent: null,
            session_id: `baby-1`,
        } ) ).toBe( false )

    } )

    it( `prints canonical Babysit ids beside captured native agent ids`, async () => {

        const output = await capture_console( async () => {
            print_resumable_sessions_table( sessions )
        } )

        expect( output ).toContain( `Resumable babysit sessions:` )
        expect( output ).toContain( `BABYSIT ID` )
        expect( output ).toContain( `AGENT SESSION ID` )
        expect( output ).toContain( `20260804-120000-c0de` )
        expect( output ).toContain( `019fcd12-c0de-7000-8000-000000000001` )
        expect( output ).toContain( `codex` )
        expect( output ).toContain( `20260803-120000-c1a0` )
        expect( output ).toContain( `019fc7ec-c1a0-7000-8000-000000000002` )
        expect( output ).toContain( `claude` )
        expect( output ).toContain( `20260802-120000-babe` )
        expect( output ).toContain( `Resume one with: babysit resume <babysit_id>` )

    } )

    it( `prints a clear empty state`, async () => {

        const output = await capture_console( async () => {
            print_resumable_sessions_table( [] )
        } )

        expect( output ).toBe( `No resumable babysit sessions.` )

    } )

    it( `renders null legacy timestamps as unknown instead of the Unix epoch`, async () => {

        const output = await capture_console( async () => {
            print_resumable_sessions_table( [ {
                babysit_id: `legacy`,
                agent: `claude`,
                started_at: null,
            } ] )
        } )

        expect( output ).toContain( `unknown` )
        expect( output ).not.toContain( `1970-01-01` )

    } )

} )

describe( `cmd_resume cwd handling`, () => {

    let original_cwd
    let temp_workspace

    beforeEach( () => {
        original_cwd = process.cwd()
        temp_workspace = mkdtempSync( join( tmpdir(), `babysit-resume-test-` ) )
    } )

    afterEach( () => {
        // Restore cwd no matter what happened, then clean up
        try {
            process.chdir( original_cwd )
        } catch { /* best effort */ }
        rmSync( temp_workspace, { recursive: true, force: true } )
    } )

    it( `chdirs to session.pwd before delegating to cmd_start`, async () => {

        // Seed a session whose pwd is the temp workspace; we run cmd_resume
        // from a different cwd and assert it ends up in temp_workspace before
        // cmd_start picks up babysit.yaml.
        const session = make_session( temp_workspace )

        // Place a marker babysit.yaml in temp_workspace so we can verify that
        // load_config inside cmd_start would find it (cmd_start uses cwd).
        writeFileSync( join( temp_workspace, `babysit.yaml` ), `config: {}\nbabysit: []\n` )

        // Stand somewhere else so the chdir is observable
        const elsewhere = mkdtempSync( join( tmpdir(), `babysit-resume-elsewhere-` ) )
        process.chdir( elsewhere )

        let start_cwd = null

        await cmd_resume( {
            session_id: session.babysit_id,
            flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
            passthrough: [],
        }, {
            load_session_fn: id => id === session.babysit_id ? session : null,
            start: async () => {
                start_cwd = process.cwd()
            },
        } )

        // Process cwd should now be the seeded session's pwd before the start
        // delegate sees the resumed command.
        expect( process.cwd() ).toBe( temp_workspace )
        expect( start_cwd ).toBe( temp_workspace )

        // Cleanup
        rmSync( elsewhere, { recursive: true, force: true } )

    } )

    it( `warns and skips chdir when session.pwd no longer exists`, async () => {

        // Park the test in a throwaway dir so cmd_start (called by cmd_resume)
        // doesn't drop a default babysit.yaml into the source tree when it
        // fails to run docker. The test only cares that the chdir did NOT
        // jump to the ghost path; everything after that is best-effort.
        const safe_cwd = mkdtempSync( join( tmpdir(), `babysit-safe-` ) )
        process.chdir( safe_cwd )

        // Seed a session pointing at a since-deleted directory
        const ghost_pwd = join( tmpdir(), `babysit-ghost-${ Date.now() }` )
        mkdirSync( ghost_pwd )
        const session = make_session( ghost_pwd )
        rmSync( ghost_pwd, { recursive: true, force: true } )

        await cmd_resume( {
            session_id: session.babysit_id,
            flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
            passthrough: [],
        }, {
            load_session_fn: id => id === session.babysit_id ? session : null,
            start: async () => {},
        } )

        // We should NOT have chdir'd into the ghost path
        expect( process.cwd() ).not.toBe( ghost_pwd )

        rmSync( safe_cwd, { recursive: true, force: true } )

    } )

} )

describe( `merge_resume_flags`, () => {

    it( `keeps logging disabled when resume did not pass --log`, () => {

        const flags = merge_resume_flags(
            [ `yolo` ],
            { yolo: false, sandbox: false, mudbox: false, loop: false, log: false }
        )

        expect( flags ).toEqual( {
            yolo: true,
            sandbox: false,
            mudbox: false,
            docker: false,
            loop: false,
            ignore_host_agents_md: false,
            name: false,
            log: false,
            ports: [],
        } )

    } )

    it( `preserves bare --log as the default-path sentinel`, () => {

        const flags = merge_resume_flags(
            [],
            { yolo: false, sandbox: false, mudbox: false, loop: false, log: `` }
        )

        expect( flags.log ).toBe( `` )

    } )

    it( `preserves explicit --log paths`, () => {

        const flags = merge_resume_flags(
            [],
            { yolo: false, sandbox: false, mudbox: false, loop: false, log: `runs/babysit.log` }
        )

        expect( flags.log ).toBe( `runs/babysit.log` )

    } )

    it( `preserves stored port mappings on dead-session resume`, () => {

        const flags = merge_resume_flags(
            [ `yolo` ],
            { yolo: false, sandbox: false, mudbox: false, loop: false, log: false, ports: [] },
            { ports: [ `80:80`, `663:12345` ] }
        )

        expect( flags.ports ).toEqual( [ `80:80`, `663:12345` ] )

    } )

    it( `lets explicit resume-time ports replace stored mappings`, () => {

        const flags = merge_resume_flags(
            [ `yolo` ],
            { yolo: false, sandbox: false, mudbox: false, loop: false, log: false, ports: [ `3000:3000` ] },
            { ports: [ `80:80` ] }
        )

        expect( flags.ports ).toEqual( [ `3000:3000` ] )

    } )

    it( `preserves a stored session name across resume`, () => {

        const flags = merge_resume_flags(
            [ `yolo` ],
            { name: false },
            { name: `feature 1` }
        )

        expect( flags.name ).toBe( `feature 1` )

    } )

    it( `preserves host-profile isolation across resume`, () => {

        const flags = merge_resume_flags(
            [ `yolo`, `ignore-host-agents-md` ],
            { ignore_host_agents_md: false }
        )

        expect( flags.ignore_host_agents_md ).toBe( true )

    } )

    it( `lets an explicit resume-time name replace the stored name`, () => {

        const flags = merge_resume_flags(
            [ `yolo` ],
            { name: `feature 2` },
            { name: `feature 1` }
        )

        expect( flags.name ).toBe( `feature 2` )

    } )

} )

describe( `resumed session names`, () => {

    it( `keeps a stored name for explicit-agent resumes`, () => {
        expect( resolve_session_display_name(
            { name: false },
            { name: `feature 1` }
        ) ).toBe( `feature 1` )
    } )

    it( `prefers an explicit replacement name`, () => {
        expect( resolve_session_display_name(
            { name: `feature 2` },
            { name: `feature 1` }
        ) ).toBe( `feature 2` )
    } )

} )

describe( `resume target resolution`, () => {

    it( `uses captured agent-native session ids when present`, () => {

        const target = resolve_resume_target( {
            babysit_id: `20260505-120000-abcd`,
            agent_session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
        } )

        expect( target ).toEqual( {
            session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
            resume_latest: false,
        } )

    } )

    it( `uses latest-session fallback instead of passing Babysit ids to agents`, () => {

        const target = resolve_resume_target( {
            babysit_id: `20260505-120000-abcd`,
            agent_session_id: null,
        } )

        expect( target ).toEqual( {
            session_id: null,
            resume_latest: true,
        } )

    } )

} )

describe( `explicit agent resume target resolution`, () => {

    const codex = { name: `codex` }

    it( `passes unknown ids through as native agent ids`, () => {

        const target = resolve_agent_resume_target(
            { verb: `resume`, session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397` },
            codex,
            () => null
        )

        expect( target ).toEqual( {
            session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
            resume_latest: false,
        } )

    } )

    it( `translates Babysit ids to captured native ids`, () => {

        const target = resolve_agent_resume_target(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => ( {
                agent: `codex`,
                agent_session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
            } )
        )

        expect( target ).toEqual( {
            session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
            resume_latest: false,
        } )

    } )

    it( `falls back to latest when a Babysit record lacks a native id`, () => {

        const target = resolve_agent_resume_target(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => ( {
                agent: `codex`,
                agent_session_id: null,
            } )
        )

        expect( target ).toEqual( {
            session_id: null,
            resume_latest: true,
        } )

    } )

    it( `reports an agent mismatch instead of passing the wrong id through`, () => {

        const target = resolve_agent_resume_target(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => ( {
                agent: `claude`,
                agent_session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
            } )
        )

        expect( target.agent_mismatch ).toBe( `claude` )

    } )

    it( `finds stored metadata so explicit agent resumes can restore cwd`, () => {

        const stored = {
            agent: `codex`,
            pwd: `/workspace/app`,
            agent_session_id: `019df81b-ce45-70f0-ab6e-3cbd64c83397`,
        }

        expect( resolve_stored_agent_resume_session(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => stored
        ) ).toEqual( stored )

    } )

    it( `keeps host-profile isolation on explicit-agent resumes`, () => {

        const stored = resolve_stored_agent_resume_session(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => ( {
                agent: `codex`,
                modifiers: [ `ignore-host-agents-md` ],
            } )
        )

        expect( should_ignore_host_agent_context(
            { ignore_host_agents_md: false },
            stored
        ) ).toBe( true )

    } )

    it( `uses explicit host-profile isolation for native agent resumes`, () => {
        expect( should_ignore_host_agent_context( {
            ignore_host_agents_md: true,
        } ) ).toBe( true )
    } )

    it( `keeps host agent context by default`, () => {
        expect( should_ignore_host_agent_context() ).toBe( false )
    } )

    it( `marks stored metadata mismatches before cwd restoration`, () => {

        const stored = resolve_stored_agent_resume_session(
            { verb: `resume`, session_id: `20260505-120000-abcd` },
            codex,
            () => ( { agent: `claude`, pwd: `/workspace/app` } )
        )

        expect( stored.agent_mismatch ).toBe( `claude` )

    } )

} )

describe( `resume prompt handling`, () => {

    it( `does not type the startup prompt into resumed sessions`, () => {
        expect( should_send_initial_prompt( { verb: `resume` } ) ).toBe( false )
    } )

    it( `still types the startup prompt into fresh sessions`, () => {
        expect( should_send_initial_prompt( { verb: `start` } ) ).toBe( true )
    } )

} )
