import { describe, it, expect } from 'bun:test'
import { create_session } from '../src/tmux/session.js'

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
