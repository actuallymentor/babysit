import { describe, it, expect } from 'bun:test'
import { attach_session, create_session, get_session_pane, has_session, kill_session, list_sessions, set_agent_status } from '../src/tmux/session.js'

describe( `create_session status bar`, () => {

    it( `configures a bottom, session-local, literal-safe identity`, async () => {

        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( { command, args } )
            return ``
        }
        const status_label = `Check out settings · dev/project · [yolo, docker, clone]`

        await create_session( `babysit_test`, `agent`, { status_label, run_command } )

        expect( calls[0].args ).toContain( `new-session` )

        const status_calls = calls.filter( call =>
            call.args.includes( `status` )
            || call.args.includes( `status-position` )
            || call.args.includes( `status-left` )
            || call.args.includes( `status-left-length` )
            || call.args.includes( `@babysit_status_label` )
        )

        expect( status_calls ).toHaveLength( 5 )
        expect( status_calls.every( call => call.command === `tmux` ) ).toBe( true )
        expect( status_calls.every( call => call.args.includes( `babysit_test` ) ) ).toBe( true )
        expect( status_calls.every( call => !call.args.includes( `-g` ) ) ).toBe( true )
        expect( status_calls.find( call => call.args.includes( `@babysit_status_label` ) ).args.at( -1 ) ).toBe( status_label )
        expect( status_calls.find( call => call.args.includes( `status-position` ) ).args.at( -1 ) ).toBe( `bottom` )
        expect( status_calls.find( call => call.args.includes( `status-left` ) ).args.at( -1 ) )
            .toBe( `#[bold]#{@babysit_status_label}#[default] ` )
        expect( Number(
            status_calls.find( call => call.args.includes( `status-left-length` ) ).args.at( -1 )
        ) ).toBeGreaterThan( status_label.length )

    } )

    it( `keeps the session usable when cosmetic status setup fails`, async () => {

        const run_command = async ( command, args ) => {
            if( args.includes( `status-position` ) ) throw new Error( `unsupported option` )
            return ``
        }

        await expect( create_session( `babysit_test`, `agent`, {
            status_label: `workspace/project`,
            run_command,
        } ) ).resolves.toEqual( { pipe_started: false } )

    } )

} )

describe( `get_session_pane`, () => {

    it( `uses exact tmux targeting and validates the pane id`, async () => {
        const calls = []
        const result = await get_session_pane( `babysit_one`, {
            run_command: async ( command, args ) => {
                calls.push( { command, args } )
                return `%12:detached\n`
            },
        } )

        expect( result ).toEqual( { pane_id: `%12`, attachment: `detached` } )
        expect( calls[0].args ).toContain( `=babysit_one:` )
    } )

    it( `rejects non-pane targets`, async () => {
        expect( get_session_pane( `babysit_one`, {
            run_command: async () => `babysit_one:detached`,
        } ) ).rejects.toThrow( `exact tmux pane` )
    } )

} )

describe( `attach_session`, () => {

    it( `returns control after tmux reports a non-zero detach exit`, () => {

        const exec_command = () => {
            throw new Error( `detached` )
        }

        expect( attach_session( `babysit_test`, { exec_command } ) ).toBe( true )

    } )

    it( `requires an exact tmux session name`, () => {
        const commands = []

        attach_session( `babysit_test`, {
            exec_command: command => commands.push( command ),
        } )

        expect( commands[0] ).toContain( `attach -t "=babysit_test"` )
    } )

} )

describe( `exact session lifecycle targets`, () => {

    it( `does not allow tmux prefix matching for liveness or termination`, async () => {
        const calls = []
        const run_command = async ( command, args ) => calls.push( { command, args } )

        expect( await has_session( `babysit_one`, { run_command } ) ).toBe( true )
        await kill_session( `babysit_one`, { run_command } )

        expect( calls ).toHaveLength( 2 )
        expect( calls.every( call => call.args.includes( `=babysit_one` ) ) ).toBe( true )
    } )

} )

describe( `list_sessions format compatibility`, () => {

    it( `preserves session identity and status when tmux sanitizes control characters`, async () => {
        const rows = [
            { session_name: `babysit_idle`, session_created: `123`, babysit_agent_status: `idle` },
            { session_name: `babysit_running`, session_created: `124`, babysit_agent_status: `running` },
        ]
        const result = await list_sessions( {
            run_command: async ( command, args ) => {
                // Tmux 3.3a replaces literal tab characters in the format with
                // underscores. Render the supplied format so this tests the
                // production command, rather than assuming its wire format.
                const format = args.at( -1 ).replaceAll( `\t`, `_` )
                return rows.map( row => format
                    .replaceAll( `#{session_name}`, row.session_name )
                    .replaceAll( `#{?session_attached,attached,detached}`, `detached` )
                    .replaceAll( `#{session_created}`, row.session_created )
                    .replaceAll( `#{@babysit_agent_status}`, row.babysit_agent_status )
                ).join( `\n` )
            },
        } )

        expect( result ).toEqual( [
            { name: `babysit_idle`, attached: false, created: `123`, agent_status: `idle` },
            { name: `babysit_running`, attached: false, created: `124`, agent_status: `running` },
        ] )
    } )

} )


describe( `set_agent_status`, () => {

    it( `uses exact target-pane syntax supported by older tmux set-option`, async () => {
        const result = await set_agent_status( `babysit_one`, `idle`, {
            run_command: async ( command, args ) => {
                expect( args ).toContain( `=babysit_one:` )
                expect( args.slice( -2 ) ).toEqual( [ `@babysit_agent_status`, `idle` ] )
            },
        } )

        expect( result ).toBe( true )
    } )

} )
