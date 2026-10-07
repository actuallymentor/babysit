import { describe, it, expect } from 'bun:test'
import { cmd_restart, local_image_id } from '../src/cli/restart.js'
import { parse_args } from '../src/cli/parse.js'

const session = { babysit_id: `s1`, agent: `codex`, tmux_session: `babysit_s1`, image_id: `sha256:aaaaaaaaaaaaaaaa` }

const harness = ( { status = `idle`, image = `sha256:bbbbbbbbbbbbbbbb`, stuck = false } = {} ) => {
    const events = []
    const seams = {
        select: async selector => {
            events.push( `select ${ selector }` ); return { ...session, ...stuck ? { stuck_at: `now` } : {} } 
        },
        observe: async sessions => sessions.map( tmux => ( { ...tmux, agent_status: status } ) ),
        close: async s => events.push( `close ${ s.babysit_id }` ),
        resume: async cmd => events.push( `resume ${ cmd.session_id } detached=${ cmd.detached }` ),
        image_id: async () => image,
        print: message => events.push( message ),
    }
    return { events, seams }
}

describe( `babysit restart`, () => {

    it( `closes then resumes an idle session and reports the image change`, async () => {
        const { events, seams } = harness()
        await cmd_restart( { session_id: `2`, flags: {} }, seams )
        expect( events ).toEqual( [
            `select 2`, `close s1`, `resume s1 detached=false`,
            `Restarted s1 on image bbbbbbbbbbbb (updated from aaaaaaaaaaaa).`,
        ] )
    } )

    it( `reports an unchanged image and honours --detach`, async () => {
        const { events, seams } = harness( { image: session.image_id } )
        await cmd_restart( { session_id: `s1`, flags: { detach: true } }, seams )
        expect( events.at( -2 ) ).toBe( `resume s1 detached=true` )
        expect( events.at( -1 ) ).toContain( `(unchanged)` )
    } )

    it.each( [ `running`, `unknown` ] )( `refuses a %s session without --force`, async status => {
        const { events, seams } = harness( { status } )
        await expect( cmd_restart( { session_id: `1`, flags: {} }, seams ) ).rejects.toThrow( `is ${ status }; restart it between turns` )
        expect( events ).toEqual( [ `select 1` ] )
    } )

    it( `treats a stuck flag as not restartable, and --force overrides every check`, async () => {
        const stuck = harness( { stuck: true } )
        await expect( cmd_restart( { session_id: `1`, flags: {} }, stuck.seams ) ).rejects.toThrow( `is stuck` )
        const forced = harness( { status: `running` } )
        forced.seams.observe = async () => {
            throw new Error( `observe must not run with --force` ) 
        }
        await cmd_restart( { session_id: `1`, flags: { force: true } }, forced.seams )
        expect( forced.events ).toContain( `close s1` )
    } )

    it( `reads the local image id and tolerates a missing image`, async () => {
        expect( await local_image_id( { run_command: async () => `sha256:abc\n` } ) ).toBe( `sha256:abc` )
        expect( await local_image_id( { run_command: async () => {
            throw new Error( `no such image` ) 
        } } ) ).toBeNull()
    } )

    it( `parses the restart verb`, () => {
        expect( parse_args( [ `restart`, `3`, `--force` ] ) ).toMatchObject( { verb: `restart`, session_id: `3`, flags: { force: true, detach: false } } )
        expect( parse_args( [ `restart`, `s1`, `--detach` ] ).flags.detach ).toBe( true )
        expect( () => parse_args( [ `restart` ] ) ).toThrow( `Usage: babysit restart` )
        expect( () => parse_args( [ `restart`, `3`, `--yolo` ] ) ).toThrow( `Unknown restart argument: --yolo` )
    } )

} )
