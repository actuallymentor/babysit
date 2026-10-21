import { describe, it, expect } from 'bun:test'
import { cmd_restart, local_image_id, restart_blocker, unarchived_sessions } from '../src/cli/restart.js'
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
        sleep: async () => {},
        best_account: async () => {
            events.push( `best account` ); return `spare`
        },
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

    it( `reads a still Claude composer footer as idle, a redrawing one as running`, async () => {
        const claude = { agent: `claude` }
        const composer = `❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)`
        const idle = harness( { pane: composer, overrides: claude } )
        await cmd_restart( { session_id: `1`, flags: {} }, idle.seams )
        expect( idle.events.filter( event => event.startsWith( `capture` ) ) ).toHaveLength( 2 )
        expect( idle.events.some( event => event.startsWith( `close` ) ) ).toBe( true )

        // The spinner timer changes between captures
        const running = harness( { overrides: claude } )
        let tick = 0
        running.seams.capture = async () => `✽ Wrangling… (${ tick++ }s · ↓ 21 tokens)\n${ composer }`
        await expect( cmd_restart( { session_id: `1`, flags: {} }, running.seams ) ).rejects.toThrow( `shows running` )

        // No composer footer, no evidence
        const dialog = harness( { pane: `Connecting to Claude…`, overrides: claude } )
        await expect( cmd_restart( { session_id: `1`, flags: {} }, dialog.seams ) ).rejects.toThrow( `shows no idle control` )
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

    it( `restarts every unarchived session detached, skipping and reporting refusals`, async () => {
        const { events, seams } = harness()
        const sessions = [ session, { ...session, babysit_id: `s2`, modifiers: [ `sandbox` ] }, { ...session, babysit_id: `s3` } ]
        await expect( cmd_restart( { session_id: `all`, flags: {} }, { ...seams, select_all: async () => sessions, load: () => null } ) )
            .rejects.toThrow( `1 of 3 sessions not restarted: s2` )
        expect( events ).toContain( `Skipped s2: Sandbox sessions keep their conversation only inside the container; restarting would discard it.` )
        expect( events.filter( event => event.startsWith( `resume` ) ).map( event => event.split( ` ` ).slice( 0, 3 ).join( ` ` ) ) )
            .toEqual( [ `resume s1 detached=true`, `resume s3 detached=true` ] )

        // A failed resume leaves that session closed: stop before closing the next one
        const broken = harness()
        broken.seams.resume = async () => {
            throw new Error( `pull failed` ) 
        }
        await expect( cmd_restart( { session_id: `all`, flags: {} }, { ...broken.seams, select_all: async () => sessions, load: () => null } ) )
            .rejects.toThrow( `s1 closed but did not resume (pull failed); run babysit resume s1` )
        expect( broken.events.filter( event => event.startsWith( `close` ) ) ).toHaveLength( 1 )

        // Fresh metadata wins: a session that turned stuck mid-batch is refused
        const stale = harness()
        await expect( cmd_restart( { session_id: `all`, flags: {} }, { ...stale.seams, select_all: async () => [ session ], load: () => ( { ...session, stuck_at: `now` } ) } ) )
            .rejects.toThrow( `1 of 1 sessions not restarted` )

        const empty = harness()
        await cmd_restart( { session_id: `all`, flags: {} }, { ...empty.seams, select_all: async () => [] } )
        expect( empty.events ).toEqual( [ `No unarchived sessions to restart.` ] )
    } )

    it( `moves a Claude session to the account with most headroom unless --account names one`, async () => {
        const claude = { agent: `claude`, agent_session_id: `native-1` }
        const picked = harness( { overrides: claude } )
        const resumed = []
        picked.seams.resume = async cmd => resumed.push( cmd.flags )
        await cmd_restart( { session_id: `1`, flags: { force: true } }, picked.seams )
        expect( resumed ).toEqual( [ { account: `spare` } ] )
        expect( picked.events.at( -1 ) ).toContain( `, account spare.` )

        const named = harness( { overrides: claude } )
        named.seams.resume = async cmd => resumed.push( cmd.flags )
        await cmd_restart( { session_id: `1`, flags: { force: true, account: `work` } }, named.seams )
        expect( resumed.at( -1 ) ).toEqual( { account: `work` } )
        expect( named.events ).not.toContain( `best account` )

        // Codex has no subscriptions to pick from
        const codex = harness()
        await cmd_restart( { session_id: `1`, flags: { force: true } }, codex.seams )
        expect( codex.events ).not.toContain( `best account` )
    } )

    it( `asks once about a continue prompt unless --continue was passed`, async () => {
        const sessions = { 1: session, 2: { ...session, babysit_id: `s2` } }
        const run = async flags => {
            const { seams } = harness()
            const asked = []
            const resumed = []
            await cmd_restart( { session_ids: [ `1`, `2` ], flags }, {
                ...seams, select: async selector => sessions[ selector ], load: () => null,
                ask: async () => asked.push( `ask` ) > 0,
                resume: async cmd => resumed.push( cmd.flags.continue_prompt || false ),
            } )
            return { asked, resumed }
        }
        expect( await run( {} ) ).toEqual( { asked: [ `ask` ], resumed: [ true, true ] } )
        expect( await run( { continue_prompt: true } ) ).toEqual( { asked: [], resumed: [ true, true ] } )
    } )

    it( `resolves every selector before the first close, deduplicating, then restarts detached`, async () => {
        const { events, seams } = harness()
        const sessions = { 1: session, 6: { ...session, babysit_id: `s6` }, 3: { ...session, babysit_id: `s3` }, s1: session }
        await cmd_restart( { session_ids: [ `1`, `6`, `3`, `s1` ], flags: {} }, { ...seams, select: async selector => {
            events.push( `select ${ selector }` ); return sessions[ selector ]
        }, load: () => null } )
        expect( events.slice( 0, 4 ) ).toEqual( [ `select 1`, `select 6`, `select 3`, `select s1` ] )
        expect( events.filter( event => event.startsWith( `resume` ) ).map( event => event.split( ` ` ).slice( 0, 3 ).join( ` ` ) ) )
            .toEqual( [ `resume s1 detached=true`, `resume s6 detached=true`, `resume s3 detached=true` ] )

        // A bad selector fails before anything closes
        const bad = harness()
        await expect( cmd_restart( { session_ids: [ `1`, `9` ], flags: {} }, { ...bad.seams, select: async selector => {
            if( selector === `9` ) throw new Error( `No active session numbered 9` ); return session
        } } ) ).rejects.toThrow( `numbered 9` )
        expect( bad.events.some( event => event.startsWith( `close` ) ) ).toBe( false )
    } )

    it( `selects live, unarchived stored sessions only`, async () => {
        const stored = [
            { babysit_id: `a`, tmux_session: `babysit_a`, pwd: `/w` },
            { babysit_id: `b`, tmux_session: `babysit_b`, pwd: `/w`, archived_at: `2026-10-01` },
            { babysit_id: `c`, tmux_session: `babysit_c`, pwd: `/w` },
        ]
        const selected = await unarchived_sessions( {
            inspect_records: () => ( { records: stored.map( session => ( { session } ) ) } ),
            sessions: async () => [ { name: `babysit_a` }, { name: `babysit_b` }, { name: `babysit_x` } ],
        } )
        expect( selected.map( session => session.babysit_id ) ).toEqual( [ `a` ] )
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
        expect( parse_args( [ `restart`, `all`, `--force` ] ) ).toMatchObject( { session_id: `all`, flags: { force: true } } )
        expect( () => parse_args( [ `restart` ] ) ).toThrow( `Usage: babysit restart` )
        expect( parse_args( [ `restart`, `1`, `6`, `--detach`, `3` ] ) ).toMatchObject( { session_id: `1`, session_ids: [ `1`, `6`, `3` ], flags: { detach: true } } )
        expect( parse_args( [ `restart`, `1`, `6`, `--account`, `work` ] ) ).toMatchObject( { session_ids: [ `1`, `6` ], flags: { account: `work` } } )
        expect( () => parse_args( [ `restart`, `all`, `2` ] ) ).toThrow( `restart all takes no other selectors` )
        expect( parse_args( [ `close`, `3`, `4`, `5` ] ) ).toMatchObject( { verb: `close`, session_id: `3`, session_ids: [ `3`, `4`, `5` ] } )
        expect( () => parse_args( [ `close`, `3`, `--force` ] ) ).toThrow( `Unknown close argument: --force` )
        expect( () => parse_args( [ `restart`, `3`, `--yolo` ] ) ).toThrow( `Unknown restart argument: --yolo` )
    } )

    it( `only offers X clipboard tools with a display, and silences their stdout`, () => {
        const have = ( ...names ) => name => names.includes( name )
        expect( clipboard_command( { platform: `linux`, env: {}, exists: have( `xclip` ) } ) ).toBeNull()
        expect( clipboard_command( { platform: `linux`, env: { DISPLAY: `:0` }, exists: have( `xclip` ) } ) ).toBe( `xclip -selection clipboard >/dev/null` )
    } )

} )
