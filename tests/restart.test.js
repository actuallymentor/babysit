import { describe, it, expect } from 'bun:test'
import { cmd_restart, local_image_id, restart_blocker } from '../src/cli/restart.js'
import { parse_args } from '../src/cli/parse.js'
import { clipboard_command } from '../src/tmux/session.js'

const session = {
    babysit_id: `s1`, agent: `codex`, tmux_session: `babysit_s1`, image_id: `sha256:aaaaaaaaaaaaaaaa`,
    agent_session_id: `native-1`, launch_spec: { args: [ `--model`, `gpt-6` ], environment: { CODEX_HOME: `/saved` } },
}
const IDLE_PANE = `› Ask Codex to do anything\n? for shortcuts`
const RUNNING_PANE = `Working… (esc to interrupt)`

const harness = ( { pane = IDLE_PANE, image = `sha256:bbbbbbbbbbbbbbbb`, overrides = {} } = {} ) => {
    const events = []
    const seams = {
        select: async selector => {
            events.push( `select ${ selector }` ); return { ...session, ...overrides } 
        },
        capture: async target => {
            events.push( `capture ${ target }` ); return pane 
        },
        close: async s => events.push( `close ${ s.babysit_id } env=${ process.env.CODEX_HOME }` ),
        resume: async cmd => events.push( `resume ${ cmd.session_id } detached=${ cmd.detached } args=${ cmd.passthrough.join( ` ` ) } env=${ process.env.CODEX_HOME }` ),
        image_id: async () => {
            events.push( `image` ); return image 
        },
        print: message => events.push( message ),
    }
    return { events, seams }
}

describe( `babysit restart`, () => {

    it( `checks the pane right before closing, then resumes with the saved args and profile`, async () => {
        const { events, seams } = harness()
        const previous = process.env.CODEX_HOME
        process.env.CODEX_HOME = `/caller`
        try {
            await cmd_restart( { session_id: `2`, flags: {} }, seams )
        } finally {
            process.env.CODEX_HOME = previous
        }
        expect( events ).toEqual( [
            `select 2`, `image`, `capture =babysit_s1:`,
            `close s1 env=/saved`, `resume s1 detached=false args=--model gpt-6 env=/saved`,
            `Restarted s1 on image bbbbbbbbbbbb (updated from aaaaaaaaaaaa).`,
        ] )
        expect( process.env.CODEX_HOME ).toBe( previous )
    } )

    it( `reports an unchanged image and honours --detach`, async () => {
        const { events, seams } = harness( { image: session.image_id } )
        await cmd_restart( { session_id: `s1`, flags: { detach: true } }, seams )
        expect( events.at( -2 ) ).toContain( `detached=true` )
        expect( events.at( -1 ) ).toContain( `(unchanged)` )
    } )

    it( `refuses a running turn or an unrecognised screen without --force`, async () => {
        for( const [ pane, message ] of [ [ RUNNING_PANE, `shows running` ], [ `Connecting to provider…`, `shows no idle control` ] ] ) {
            const { events, seams } = harness( { pane } )
            await expect( cmd_restart( { session_id: `1`, flags: {} }, seams ) ).rejects.toThrow( message )
            expect( events.some( event => event.startsWith( `close` ) ) ).toBe( false )
        }
    } )

    it( `treats a stuck flag as not restartable, and --force skips the pane check`, async () => {
        const stuck = harness( { overrides: { stuck_at: `now` } } )
        await expect( cmd_restart( { session_id: `1`, flags: {} }, stuck.seams ) ).rejects.toThrow( `shows stuck` )
        const forced = harness( { pane: RUNNING_PANE } )
        await cmd_restart( { session_id: `1`, flags: { force: true } }, forced.seams )
        expect( forced.events.some( event => event.startsWith( `capture` ) ) ).toBe( false )
        expect( forced.events.some( event => event.startsWith( `close` ) ) ).toBe( true )
    } )

    it( `never restarts a sandbox and needs --force without a native id`, async () => {
        expect( restart_blocker( { ...session, modifiers: [ `sandbox` ] } ) ).toContain( `Sandbox` )
        expect( restart_blocker( { ...session, agent_session_id: null } ) ).toContain( `--force` )
        expect( restart_blocker( session ) ).toBeNull()
        const sandbox = harness( { overrides: { modifiers: [ `sandbox` ] } } )
        await expect( cmd_restart( { session_id: `1`, flags: { force: true } }, sandbox.seams ) ).rejects.toThrow( `Sandbox` )
        const anonymous = harness( { overrides: { agent_session_id: null } } )
        await expect( cmd_restart( { session_id: `1`, flags: {} }, anonymous.seams ) ).rejects.toThrow( `No native codex session id` )
        await cmd_restart( { session_id: `1`, flags: { force: true } }, harness( { overrides: { agent_session_id: null } } ).seams )
    } )

    it( `reads the local image id and tolerates a missing image`, async () => {
        expect( await local_image_id( { run_command: async () => `sha256:abc\n` } ) ).toBe( `sha256:abc` )
        expect( await local_image_id( { run_command: async () => {
            throw new Error( `no such image` ) 
        } } ) ).toBeNull()
    } )

    it( `parses the restart verb with flags on either side of the selector`, () => {
        expect( parse_args( [ `restart`, `3`, `--force` ] ) ).toMatchObject( { verb: `restart`, session_id: `3`, flags: { force: true, detach: false } } )
        expect( parse_args( [ `restart`, `--force`, `3` ] ) ).toMatchObject( { session_id: `3`, flags: { force: true } } )
        expect( parse_args( [ `restart`, `--detach`, `s1` ] ) ).toMatchObject( { session_id: `s1`, flags: { detach: true } } )
        expect( () => parse_args( [ `restart` ] ) ).toThrow( `Usage: babysit restart` )
        expect( () => parse_args( [ `restart`, `3`, `--yolo` ] ) ).toThrow( `Unknown restart argument: --yolo` )
    } )

    it( `only offers X clipboard tools with a display, and silences their stdout`, () => {
        const have = ( ...names ) => name => names.includes( name )
        expect( clipboard_command( { platform: `linux`, env: {}, exists: have( `xclip` ) } ) ).toBeNull()
        expect( clipboard_command( { platform: `linux`, env: { DISPLAY: `:0` }, exists: have( `xclip` ) } ) ).toBe( `xclip -selection clipboard >/dev/null` )
    } )

} )
