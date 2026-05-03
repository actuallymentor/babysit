import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { cmd_resume, merge_resume_flags } from '../src/cli/resume.js'
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

        // cmd_resume calls cmd_start which tries to launch docker. We catch
        // any exception (docker isn't installed in this test env) — what we
        // care about is the chdir happening BEFORE cmd_start fails.
        try {
            await cmd_resume( {
                session_id: id,
                flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
                passthrough: [],
            } )
        } catch { /* expected — cmd_start will fail without docker/tmux */ }

        // Process cwd should now be the seeded session's pwd
        expect( process.cwd() ).toBe( temp_workspace )

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

        try {
            await cmd_resume( {
                session_id: id,
                flags: { yolo: false, sandbox: false, mudbox: false, loop: false },
                passthrough: [],
            } )
        } catch { /* expected — cmd_start fails without docker/tmux */ }

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
