import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { cmd_resume, merge_resume_flags, resolve_resume_target } from '../src/cli/resume.js'
import { resolve_agent_resume_target, resolve_stored_agent_resume_session, should_send_initial_prompt } from '../src/cli/start.js'
import { generate_session_id, save_session } from '../src/sessions/store.js'

// Create a session record on disk that resume.js will look up. Returns the
// id we can resume by, plus the temp pwd we expect the resume to chdir into.
const seed_session = ( pwd ) => {

    const id = generate_session_id()
    save_session( {
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
    } )
    return id

}

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

        // Clean up the seeded session record
        try {
            const sessions_dir = join( homedir(), `.babysit`, `sessions` )
            const id_file = join( sessions_dir, `*.json` )
            // Best-effort cleanup — a stray test session won't break later tests.
            void id_file
        } catch { /* ignore */ }
    } )

    it( `chdirs to session.pwd before delegating to cmd_start`, async () => {

        // Seed a session whose pwd is the temp workspace; we run cmd_resume
        // from a different cwd and assert it ends up in temp_workspace before
        // cmd_start picks up babysit.yaml.
        const id = seed_session( temp_workspace )

        // Place a marker babysit.yaml in temp_workspace so we can verify that
        // load_config inside cmd_start would find it (cmd_start uses cwd).
        writeFileSync( join( temp_workspace, `babysit.yaml` ), `config: {}\nbabysit: []\n` )

        // Stand somewhere else so the chdir is observable
        const elsewhere = mkdtempSync( join( tmpdir(), `babysit-resume-elsewhere-` ) )
        process.chdir( elsewhere )

        let start_cwd = null

        await cmd_resume( {
            session_id: id,
            flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
            passthrough: [],
        }, {
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
        const id = seed_session( ghost_pwd )
        rmSync( ghost_pwd, { recursive: true, force: true } )

        await cmd_resume( {
            session_id: id,
            flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
            passthrough: [],
        }, {
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
            log: false,
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
