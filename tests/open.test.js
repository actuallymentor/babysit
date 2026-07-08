import { describe, it, expect } from 'bun:test'
import { active_sessions_for_pwd, cmd_open } from '../src/cli/open.js'
import { log } from '../src/utils/log.js'

const session_fixtures = () => {

    const tmux_sessions = [
        { name: `babysit_/workspace/app_codex_1`, attached: false },
        { name: `babysit_/workspace/app_claude_2`, attached: true },
        { name: `babysit_/workspace/other_codex_3`, attached: false },
    ]

    const stored_sessions = [
        {
            babysit_id: `baby-1`,
            agent: `codex`,
            agent_session_id: `agent-1`,
            tmux_session: `babysit_/workspace/app_codex_1`,
            pwd: `/workspace/app`,
        },
        {
            babysit_id: `baby-2`,
            agent: `claude`,
            agent_session_id: null,
            tmux_session: `babysit_/workspace/app_claude_2`,
            pwd: `/workspace/app`,
        },
        {
            babysit_id: `baby-3`,
            agent: `codex`,
            agent_session_id: `agent-3`,
            tmux_session: `babysit_/workspace/other_codex_3`,
            pwd: `/workspace/other`,
        },
    ]

    return { tmux_sessions, stored_sessions }

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

const capture_errors = async ( fn ) => {

    const original_error = log.error
    const lines = []

    log.error = line => lines.push( String( line ) )

    try {
        await fn()
    } finally {
        log.error = original_error
    }

    return lines

}

describe( `active_sessions_for_pwd`, () => {

    it( `filters active sessions to the stored current-directory matches`, () => {

        const { tmux_sessions, stored_sessions } = session_fixtures()
        const matches = active_sessions_for_pwd( `/workspace/app`, tmux_sessions, stored_sessions )

        expect( matches.map( session => session.name ) ).toEqual( [
            `babysit_/workspace/app_codex_1`,
            `babysit_/workspace/app_claude_2`,
        ] )

    } )

    it( `ignores stale metadata whose tmux session is no longer active`, () => {

        const { tmux_sessions, stored_sessions } = session_fixtures()
        const matches = active_sessions_for_pwd( `/workspace/app`, tmux_sessions.slice( 0, 1 ), stored_sessions )

        expect( matches.map( session => session.name ) ).toEqual( [
            `babysit_/workspace/app_codex_1`,
        ] )

    } )

} )

describe( `cmd_open without a session id`, () => {

    it( `attaches to the only active session for the current directory`, async () => {

        const { tmux_sessions, stored_sessions } = session_fixtures()
        let attached_session = null

        await cmd_open( { session_id: null }, {
            cwd: `/workspace/other`,
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => stored_sessions,
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_/workspace/other_codex_3` )

    } )

    it( `prints a selectable table when several active sessions match the current directory`, async () => {

        const { tmux_sessions, stored_sessions } = session_fixtures()
        let attached_session = null

        const output = await capture_console( async () => {
            await cmd_open( { session_id: null }, {
                cwd: `/workspace/app`,
                list_sessions_fn: async () => tmux_sessions,
                list_stored_sessions_fn: () => stored_sessions,
                attach_session_fn: session_name => {
                    attached_session = session_name
                },
                exit_fn: code => {
                    throw new Error( `Unexpected exit ${ code }` )
                },
            } )
        } )

        expect( attached_session ).toBeNull()
        expect( output ).toContain( `Active babysit sessions for /workspace/app:` )
        expect( output ).toContain( `SESSION` )
        expect( output ).toContain( `AGENT` )
        expect( output ).toContain( `ID` )
        expect( output ).toContain( `agent-1` )
        expect( output ).toContain( `baby-2` )

    } )

    it( `exits when the current directory has no active session`, async () => {

        const { tmux_sessions, stored_sessions } = session_fixtures()
        let exit_code = null
        let attached_session = null

        const errors = await capture_errors( async () => {
            await cmd_open( { session_id: null }, {
                cwd: `/workspace/missing`,
                list_sessions_fn: async () => tmux_sessions,
                list_stored_sessions_fn: () => stored_sessions,
                attach_session_fn: session_name => {
                    attached_session = session_name
                },
                exit_fn: code => {
                    exit_code = code
                },
            } )
        } )

        expect( attached_session ).toBeNull()
        expect( exit_code ).toBe( 1 )
        expect( errors ).toContain( `No active session found for current directory: /workspace/missing` )

    } )

} )

describe( `cmd_open with a session id`, () => {

    it( `attaches directly when the id is an active tmux session name`, async () => {

        let attached_session = null

        await cmd_open( { session_id: `babysit_direct_codex_1` }, {
            has_session_fn: async session_name => session_name === `babysit_direct_codex_1`,
            list_sessions_fn: async () => {
                throw new Error( `Unexpected fuzzy lookup` )
            },
            list_stored_sessions_fn: () => {
                throw new Error( `Unexpected stored lookup` )
            },
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_direct_codex_1` )

    } )

    it( `attaches through stored Babysit metadata ids`, async () => {

        const { stored_sessions } = session_fixtures()
        let attached_session = null

        await cmd_open( { session_id: `baby-2` }, {
            has_session_fn: async session_name => session_name === `babysit_/workspace/app_claude_2`,
            list_sessions_fn: async () => [],
            list_stored_sessions_fn: () => stored_sessions,
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_/workspace/app_claude_2` )

    } )

    it( `attaches through stored agent-native session ids`, async () => {

        const { stored_sessions } = session_fixtures()
        let attached_session = null

        await cmd_open( { session_id: `agent-1` }, {
            has_session_fn: async session_name => session_name === `babysit_/workspace/app_codex_1`,
            list_sessions_fn: async () => [],
            list_stored_sessions_fn: () => stored_sessions,
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_/workspace/app_codex_1` )

    } )

    it( `attaches through partial stored tmux session ids`, async () => {

        const { stored_sessions } = session_fixtures()
        let attached_session = null

        await cmd_open( { session_id: `app_claude` }, {
            has_session_fn: async session_name => session_name === `babysit_/workspace/app_claude_2`,
            list_sessions_fn: async () => [],
            list_stored_sessions_fn: () => stored_sessions,
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_/workspace/app_claude_2` )

    } )

    it( `does not attach through stale stored metadata`, async () => {

        const { stored_sessions } = session_fixtures()
        let attached_session = null
        let exit_code = null

        const errors = await capture_errors( async () => {
            await cmd_open( { session_id: `baby-1` }, {
                has_session_fn: async () => false,
                list_sessions_fn: async () => [],
                list_stored_sessions_fn: () => stored_sessions,
                attach_session_fn: session_name => {
                    attached_session = session_name
                },
                exit_fn: code => {
                    exit_code = code
                },
            } )
        } )

        expect( attached_session ).toBeNull()
        expect( exit_code ).toBe( 1 )
        expect( errors ).toContain( `No active session found for: baby-1` )

    } )

    it( `falls back to fuzzy active-session matching`, async () => {

        const { tmux_sessions } = session_fixtures()
        let attached_session = null

        await cmd_open( { session_id: `other_codex` }, {
            has_session_fn: async () => false,
            list_sessions_fn: async () => tmux_sessions,
            list_stored_sessions_fn: () => [],
            attach_session_fn: session_name => {
                attached_session = session_name
            },
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )

        expect( attached_session ).toBe( `babysit_/workspace/other_codex_3` )

    } )

    it( `exits when an explicit id cannot be resolved`, async () => {

        let exit_code = null
        let attached_session = null

        const errors = await capture_errors( async () => {
            await cmd_open( { session_id: `missing-id` }, {
                has_session_fn: async () => false,
                list_sessions_fn: async () => [],
                list_stored_sessions_fn: () => [],
                attach_session_fn: session_name => {
                    attached_session = session_name
                },
                exit_fn: code => {
                    exit_code = code
                },
            } )
        } )

        expect( attached_session ).toBeNull()
        expect( exit_code ).toBe( 1 )
        expect( errors ).toContain( `No active session found for: missing-id` )

    } )

} )
