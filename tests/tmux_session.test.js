import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { attach_session, clipboard_command, create_session, get_session_pane, has_session, kill_session, list_sessions, mark_idle, mark_read, set_agent_status } from '../src/tmux/session.js'
import { TMUX_SOCKET } from '../src/utils/paths.js'

describe( `create_session mouse copy`, () => {

    it( `copies a plain drag to the clipboard and leaves copy mode`, async () => {
        const calls = []
        await create_session( `babysit_test`, `agent`, { clipboard: `pbcopy`, run_command: async ( command, args ) => {
            calls.push( args ) 
        } } )
        const binds = calls.filter( args => args.includes( `bind-key` ) )
        expect( calls.some( args => args.join( ` ` ).includes( `set-option -s set-clipboard on` ) ) ).toBe( true )
        expect( binds.map( args => args.slice( -4 ).join( ` ` ) ) ).toEqual( [
            `send-keys -X copy-pipe-and-cancel pbcopy`,
            `send-keys -X copy-pipe-and-cancel pbcopy`,
        ] )
        expect( binds.map( args => args[ args.indexOf( `-T` ) + 1 ] ) ).toEqual( [ `copy-mode`, `copy-mode-vi` ] )
    } )

    it( `falls back to tmux's own clipboard forwarding without a host tool`, async () => {
        const calls = []
        await create_session( `babysit_test`, `agent`, { clipboard: null, run_command: async ( command, args ) => {
            calls.push( args ) 
        } } )
        expect( calls.filter( args => args.includes( `bind-key` ) ).every( args => args.at( -1 ) === `copy-selection-and-cancel` ) ).toBe( true )
    } )

    it( `picks the platform clipboard tool`, () => {
        const have = ( ...names ) => name => names.includes( name )
        expect( clipboard_command( { platform: `darwin`, exists: have( `pbcopy` ) } ) ).toBe( `pbcopy` )
        expect( clipboard_command( { platform: `linux`, env: { WAYLAND_DISPLAY: `wayland-0` }, exists: have( `wl-copy`, `xclip` ) } ) ).toBe( `wl-copy` )
        expect( clipboard_command( { platform: `linux`, env: { DISPLAY: `:0` }, exists: have( `wl-copy`, `xclip` ) } ) ).toBe( `xclip -selection clipboard >/dev/null` )
        expect( clipboard_command( { platform: `linux`, env: {}, exists: () => false } ) ).toBeNull()
    } )

} )

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

    it( `hands the attach to the shell wrapper's file instead of blocking`, () => {

        const directory = mkdtempSync( join( tmpdir(), `babysit-attach-` ) )
        const attach_file = join( directory, `attach` )
        writeFileSync( attach_file, `` )

        const exec_command = () => {
            throw new Error( `attached in-process` )
        }
        expect( attach_session( `babysit_test`, { exec_command, env: { BABYSIT_ATTACH_FILE: attach_file } } ) ).toBe( false )
        expect( readFileSync( attach_file, `utf8` ) ).toBe( `${ TMUX_SOCKET }\n=babysit_test\n` )

        // A stale variable from an exited wrapper never creates a file
        rmSync( directory, { recursive: true, force: true } )
        const commands = []
        expect( attach_session( `babysit_test`, { exec_command: command => commands.push( command ), env: { BABYSIT_ATTACH_FILE: attach_file } } ) ).toBe( true )
        expect( commands ).toHaveLength( 1 )

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
            { session_name: `babysit_idle`, session_created: `123`, babysit_agent_status: `idle`, activity: `150`, unread_since: `200`, next_turn: `1800` },
            { session_name: `babysit_running`, session_created: `124`, babysit_agent_status: `running`, activity: `201`, unread_since: `200`, next_turn: `running` },
            { session_name: `babysit_waiting`, session_created: `125`, babysit_agent_status: `waiting`, shelved: `400`, title: `✳ Fix: the bug` },
            { session_name: `babysit_looked`, session_created: `126`, babysit_agent_status: `idle`, last_attached: `300`, activity: `300`, unread_since: `200` },
            { session_name: `babysit_typed`, session_created: `127`, babysit_agent_status: `idle`, last_attached: `300`, activity: `301`, unread_since: `200` },
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
                    .replaceAll( `#{session_last_attached}`, row.last_attached ?? `` )
                    .replaceAll( `#{session_activity}`, row.activity ?? `` )
                    .replaceAll( `#{@babysit_unread_since}`, row.unread_since ?? `` )
                    .replaceAll( `#{@babysit_idle_since}`, row.unread_since ?? `` )
                    .replaceAll( `#{@babysit_next_turn}`, row.next_turn ?? `` )
                    .replaceAll( `#{@babysit_shelved_since}`, row.shelved ?? `` )
                    .replaceAll( `#{pane_title}`, row.title ?? `` )
                ).join( `\n` )
            },
        } )

        expect( result ).toEqual( [
            // No input since the stamp: unread. Input after it: read. Attach alone
            // bumps activity to the attach second, which does not count.
            { name: `babysit_idle`, attached: false, created: `123`, agent_status: `idle`, unread: true, idle_since: 200, next_turn: 1800, last_opened: null, shelved_since: null, pane_title: null },
            { name: `babysit_running`, attached: false, created: `124`, agent_status: `running`, unread: false, idle_since: 200, next_turn: null, last_opened: null, shelved_since: null, pane_title: null },
            { name: `babysit_waiting`, attached: false, created: `125`, agent_status: `waiting`, unread: false, idle_since: null, next_turn: null, last_opened: null, shelved_since: 400, pane_title: `✳ Fix: the bug` },
            { name: `babysit_looked`, attached: false, created: `126`, agent_status: `idle`, unread: true, idle_since: 200, next_turn: null, last_opened: 300, shelved_since: null, pane_title: null },
            { name: `babysit_typed`, attached: false, created: `127`, agent_status: `idle`, unread: false, idle_since: 200, next_turn: null, last_opened: 300, shelved_since: null, pane_title: null },
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


describe( `mark_idle`, () => {

    const runner = attachment => {
        const calls = []
        const run_command = async ( command, args ) => {
            calls.push( args )
            return args.includes( `display-message` ) ? `${ attachment }\n` : ``
        }
        return { calls, run_command }
    }
    const sets = calls => calls.filter( args => args.includes( `set-option` ) ).map( args => args.slice( args.indexOf( `set-option` ) + 1 ) )
    const now = () => 1_700_000_000_999

    it( `stamps idle and unread on a detached finished turn, in epoch seconds`, async () => {
        const { calls, run_command } = runner( `detached` )

        expect( await mark_idle( `babysit_one`, { run_command, now } ) ).toBe( true )
        expect( sets( calls ) ).toEqual( [
            [ `-t`, `=babysit_one:`, `@babysit_idle_since`, `1700000000` ],
            [ `-t`, `=babysit_one:`, `@babysit_unread_since`, `1700000000` ],
        ] )
    } )

    it( `marks an attached session unread too: an open terminal is not a reader`, async () => {
        const { calls, run_command } = runner( `attached` )

        expect( await mark_idle( `babysit_one`, { run_command, now } ) ).toBe( true )
        expect( sets( calls ).map( args => args[2] ) ).toEqual( [ `@babysit_idle_since`, `@babysit_unread_since` ] )
    } )

    it( `only fills a missing age on a first observation`, async () => {
        const { calls, run_command } = runner( `detached` )

        expect( await mark_idle( `babysit_one`, { finished: false, run_command, now } ) ).toBe( false )
        expect( sets( calls ) ).toEqual( [ [ `-o`, `-t`, `=babysit_one:`, `@babysit_idle_since`, `1700000000` ] ] )
    } )

    it( `mark_read unsets the unread stamp on the exact session`, async () => {
        const { calls, run_command } = runner( `detached` )

        expect( await mark_read( `babysit_one`, { run_command } ) ).toBe( true )
        expect( sets( calls ) ).toEqual( [ [ `-u`, `-t`, `=babysit_one:`, `@babysit_unread_since` ] ] )
    } )

    it( `swallows tmux failures`, async () => {
        const run_command = async () => {
            throw new Error( `no server` )
        }
        expect( await mark_read( `babysit_one`, { run_command } ) ).toBe( false )
        expect( await mark_idle( `babysit_one`, { run_command } ) ).toBe( false )
        expect( await mark_idle( `babysit_one`, { finished: false, run_command } ) ).toBe( false )
    } )

} )
