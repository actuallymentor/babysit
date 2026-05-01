import { describe, it, expect } from 'bun:test'
import { strip_ansi, last_n_lines, IdleTracker, matches_patterns, evaluate_rule } from '../src/babysit/matcher.js'

describe( `strip_ansi`, () => {

    it( `removes basic CSI sequences`, () => {
        expect( strip_ansi( `\x1b[32mhello\x1b[0m` ) ).toBe( `hello` )
    } )

    it( `replaces cursor-forward with space`, () => {
        expect( strip_ansi( `hello\x1b[5Cworld` ) ).toBe( `hello     world` )
    } )

    it( `handles mixed sequences`, () => {
        const input = `\x1b[1m\x1b[36mbabysit\x1b[0m \x1b[3Cready`
        expect( strip_ansi( input ) ).toBe( `babysit    ready` )
    } )

    it( `passes through clean text`, () => {
        expect( strip_ansi( `no escapes here` ) ).toBe( `no escapes here` )
    } )

} )

describe( `last_n_lines`, () => {

    it( `returns last N lines`, () => {
        const text = `line1\nline2\nline3\nline4\nline5`
        expect( last_n_lines( text, 2 ) ).toBe( `line4\nline5` )
    } )

    it( `returns all lines if N exceeds count`, () => {
        const text = `a\nb`
        expect( last_n_lines( text, 10 ) ).toBe( `a\nb` )
    } )

} )

describe( `IdleTracker`, () => {

    it( `reports 0 idle on first update`, () => {
        const tracker = new IdleTracker()
        expect( tracker.update( `hello` ) ).toBe( 0 )
    } )

    it( `reports 0 when output changes`, () => {
        const tracker = new IdleTracker()
        tracker.update( `hello` )
        expect( tracker.update( `world` ) ).toBe( 0 )
    } )

    it( `tracks idle time when output is unchanged`, async () => {
        const tracker = new IdleTracker()
        tracker.update( `same` )
        // Simulate passage of time
        tracker.unchanged_since = Date.now() - 5000
        expect( tracker.update( `same` ) ).toBeGreaterThanOrEqual( 4 )
    } )

    it( `resets on reset()`, () => {
        const tracker = new IdleTracker()
        tracker.update( `hello` )
        tracker.reset()
        expect( tracker.last_hash ).toBeNull()
    } )

    it( `returns null deadline when not started`, () => {
        const tracker = new IdleTracker()
        expect( tracker.get_deadline( 30 ) ).toBeNull()
    } )

    it( `computes deadline from unchanged_since + timeout`, () => {
        const tracker = new IdleTracker()
        tracker.unchanged_since = 1_700_000_000_000 // ms
        expect( tracker.get_deadline( 60 ) ).toBe( 1_700_000_000 + 60 )
    } )

} )

describe( `matches_patterns`, () => {

    it( `matches against regex list`, () => {
        const patterns = [ /needs your approval/i, /proceed\?/i ]
        expect( matches_patterns( `This needs your approval`, patterns ) ).toBe( true )
        expect( matches_patterns( `nothing here`, patterns ) ).toBe( false )
    } )

    it( `does not let global regex state leak across ticks`, () => {
        const patterns = [ /error/g ]
        expect( matches_patterns( `error`, patterns ) ).toBe( true )
        expect( matches_patterns( `error`, patterns ) ).toBe( true )
    } )

} )

describe( `evaluate_rule`, () => {

    const config = { idle_timeout_s: 300, lines_for_literal_match: 10, lines_for_regex_match: 10 }

    it( `matches idle when timeout exceeded`, () => {
        const rule = { on: { type: `idle` }, timeout_s: 10 }
        expect( evaluate_rule( rule, { output: ``, idle_seconds: 15, config } ) ).toBe( true )
        expect( evaluate_rule( rule, { output: ``, idle_seconds: 5, config } ) ).toBe( false )
    } )

    it( `matches literal string`, () => {
        const rule = { on: { type: `literal`, value: `error found` } }
        expect( evaluate_rule( rule, { output: `line1\nerror found\nline3`, idle_seconds: 0, config } ) ).toBe( true )
        expect( evaluate_rule( rule, { output: `all good`, idle_seconds: 0, config } ) ).toBe( false )
    } )

    it( `matches regex`, () => {
        const rule = { on: { type: `regex`, value: /error/i } }
        expect( evaluate_rule( rule, { output: `ERROR: something broke`, idle_seconds: 0, config } ) ).toBe( true )
        expect( evaluate_rule( rule, { output: `all good`, idle_seconds: 0, config } ) ).toBe( false )
    } )

    it( `matches global regex rules consistently`, () => {
        const rule = { on: { type: `regex`, value: /error/g } }
        expect( evaluate_rule( rule, { output: `error`, idle_seconds: 0, config } ) ).toBe( true )
        expect( evaluate_rule( rule, { output: `error`, idle_seconds: 0, config } ) ).toBe( true )
    } )

    it( `matches plan patterns`, () => {
        const agent_patterns = { plan: [ /needs your approval/i ] }
        const rule = { on: { type: `plan` } }
        expect( evaluate_rule( rule, { output: `This needs your approval`, idle_seconds: 0, agent_patterns, config } ) ).toBe( true )
    } )

    it( `matches choice patterns`, () => {
        const agent_patterns = { choice: [ /\(y\/n\)/i ] }
        const rule = { on: { type: `choice` } }
        expect( evaluate_rule( rule, { output: `Continue? (y/n)`, idle_seconds: 0, agent_patterns, config } ) ).toBe( true )
    } )

} )
