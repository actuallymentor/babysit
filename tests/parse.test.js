import { describe, it, expect } from 'bun:test'
import { parse_args } from '../src/cli/parse.js'

describe( `parse_args`, () => {

    it( `recognises babysit list`, () => {
        const cmd = parse_args( [ `list` ] )
        expect( cmd.verb ).toBe( `list` )
    } )

    it( `recognises babysit update`, () => {
        const cmd = parse_args( [ `update` ] )
        expect( cmd.verb ).toBe( `update` )
        expect( cmd.agent ).toBeNull()
    } )

    it( `recognises babysit open <id>`, () => {
        const cmd = parse_args( [ `open`, `abc-123` ] )
        expect( cmd.verb ).toBe( `open` )
        expect( cmd.session_id ).toBe( `abc-123` )
    } )

    it( `recognises babysit resume <id> with no agent`, () => {
        const cmd = parse_args( [ `resume`, `abc-123`, `--yolo` ] )
        expect( cmd.verb ).toBe( `resume` )
        expect( cmd.agent ).toBeNull()
        expect( cmd.session_id ).toBe( `abc-123` )
        expect( cmd.flags.yolo ).toBe( true )
    } )

    it( `parses babysit <agent> as start`, () => {
        const cmd = parse_args( [ `claude`, `--yolo` ] )
        expect( cmd.verb ).toBe( `start` )
        expect( cmd.agent ).toBe( `claude` )
        expect( cmd.flags.yolo ).toBe( true )
    } )

    it( `parses babysit <agent> resume <id> with agent`, () => {
        const cmd = parse_args( [ `claude`, `resume`, `abc-123`, `--yolo` ] )
        expect( cmd.verb ).toBe( `resume` )
        expect( cmd.agent ).toBe( `claude` )
        expect( cmd.session_id ).toBe( `abc-123` )
    } )

    it( `drops the resume session id from passthrough`, () => {

        // Without dedup the agent CLI would receive both --resume <id> AND <id>
        const cmd = parse_args( [ `claude`, `resume`, `abc-123`, `--yolo` ] )
        expect( cmd.passthrough ).not.toContain( `abc-123` )
        expect( cmd.passthrough ).not.toContain( `resume` )
        expect( cmd.passthrough ).not.toContain( `--yolo` )

    } )

    it( `passes unknown flags through to the agent`, () => {
        const cmd = parse_args( [ `claude`, `--model`, `sonnet`, `--effort`, `high` ] )
        expect( cmd.passthrough ).toContain( `--model` )
        expect( cmd.passthrough ).toContain( `sonnet` )
        expect( cmd.passthrough ).toContain( `--effort` )
        expect( cmd.passthrough ).toContain( `high` )
    } )

    it( `combines multiple mode flags`, () => {
        const cmd = parse_args( [ `gemini`, `--mudbox`, `--yolo`, `--loop` ] )
        expect( cmd.flags.mudbox ).toBe( true )
        expect( cmd.flags.yolo ).toBe( true )
        expect( cmd.flags.loop ).toBe( true )
    } )

    it( `sets help verb when no agent given`, () => {
        const cmd = parse_args( [] )
        expect( cmd.verb ).toBe( `help` )
    } )

    it( `recognises -v as version`, () => {
        const cmd = parse_args( [ `-v` ] )
        expect( cmd.flags.version ).toBe( true )
    } )

    it( `rejects sandbox + mudbox combination`, () => {
        // The mount strategies are contradictory — better to fail fast
        expect( () => parse_args( [ `claude`, `--sandbox`, `--mudbox` ] ) ).toThrow(
            /mutually exclusive/
        )
    } )

    it( `keeps passthrough flags on agent-less resume`, () => {

        // Previously discarded passthrough so `babysit resume <id> --model sonnet`
        // silently dropped --model sonnet
        const cmd = parse_args( [ `resume`, `abc-123`, `--yolo`, `--model`, `sonnet` ] )
        expect( cmd.verb ).toBe( `resume` )
        expect( cmd.passthrough ).toContain( `--model` )
        expect( cmd.passthrough ).toContain( `sonnet` )
        expect( cmd.passthrough ).not.toContain( `abc-123` )
        expect( cmd.passthrough ).not.toContain( `--yolo` )

    } )

    it( `does not pass babysit flags through when provided with equals syntax`, () => {
        const cmd = parse_args( [ `claude`, `--yolo=true`, `--model`, `sonnet` ] )
        expect( cmd.flags.yolo ).toBe( true )
        expect( cmd.passthrough ).not.toContain( `--yolo=true` )
        expect( cmd.passthrough ).toContain( `--model` )
    } )

    it( `recognises the internal __monitor verb`, () => {
        // __monitor is the daemon spawned by cmd_start so the supervision loop
        // outlives the foreground process. Not in --help, but the dispatcher
        // must still route to it.
        const cmd = parse_args( [ `__monitor`, `abc-123` ] )
        expect( cmd.verb ).toBe( `__monitor` )
        expect( cmd.session_id ).toBe( `abc-123` )
    } )

} )
