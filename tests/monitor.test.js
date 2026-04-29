import { describe, it, expect } from 'bun:test'
import { should_fire_rule, DEBOUNCE_MS } from '../src/babysit/monitor.js'

const make_rule = ( overrides = {} ) => ( {
    on: { type: `regex`, value: /error/i },
    do: `notify_command`,
    timeout_s: null,
    first_matched_at: null,
    last_fired_at: 0,
    ...overrides,
} )

const make_context = ( overrides = {} ) => ( {
    output: `everything fine`,
    idle_seconds: 0,
    agent_patterns: null,
    config: { idle_timeout_s: 300, lines_for_literal_match: 10, lines_for_regex_match: 10 },
    ...overrides,
} )

describe( `should_fire_rule`, () => {

    describe( `non-idle rules with no timeout`, () => {

        it( `fires immediately on match`, () => {
            const rule = make_rule()
            const ctx = make_context( { output: `something error happened` } )
            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( true )
        } )

        it( `does not fire when match is absent`, () => {
            const rule = make_rule()
            const ctx = make_context()
            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( false )
        } )

    } )

    describe( `non-idle rules with timeout (the actual bug fix)`, () => {

        // The core spec semantic: "the on: only triggers if the match is the
        // latest seen output for longer than the timeout". The pre-fix
        // implementation gated on whole-pane idle_seconds, so a rule with a
        // 5-minute timeout would never fire while the agent was actively
        // emitting unrelated output, even if the matched pattern stayed put.

        it( `arms the timer on first match but does not fire yet`, () => {
            const rule = make_rule( { timeout_s: 60 } )
            const ctx = make_context( { output: `error here` } )

            // First tick: pattern just appeared
            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( false )
            expect( rule.first_matched_at ).toBe( 1_000_000 )
        } )

        it( `still does not fire while elapsed < timeout`, () => {
            const rule = make_rule( { timeout_s: 60, first_matched_at: 1_000_000 } )
            const ctx = make_context( { output: `error here` } )

            // 30 seconds later, still under the 60s timeout
            expect( should_fire_rule( rule, ctx, 1_030_000 ) ).toBe( false )
        } )

        it( `fires once the match has persisted for the full timeout`, () => {
            const rule = make_rule( { timeout_s: 60, first_matched_at: 1_000_000 } )
            const ctx = make_context( { output: `error here` } )

            // 60 seconds later, pattern still present, idle_seconds is 0
            // because the agent has been doing other things — but we should
            // still fire, since the spec gates on match persistence, not
            // whole-pane idle.
            expect( should_fire_rule( rule, ctx, 1_060_000 ) ).toBe( true )
        } )

        it( `fires even when pane is busy (idle_seconds=0)`, () => {

            // Regression test for the original bug: pre-fix, this case would
            // never fire because idle_seconds < timeout_s short-circuited
            // before evaluating the match.
            const rule = make_rule( { timeout_s: 30, first_matched_at: 1_000_000 } )
            const ctx = make_context( {
                output: `error in line 5`,
                idle_seconds: 0,  // pane is changing every tick
            } )

            expect( should_fire_rule( rule, ctx, 1_030_000 ) ).toBe( true )
        } )

        it( `re-arms when the match disappears`, () => {

            // Pattern appears, then is pushed out of the last 10 lines by
            // newer output, then reappears later. The visibility timer must
            // restart from scratch — the old "we saw it 3 minutes ago" credit
            // does not carry over.
            const rule = make_rule( { timeout_s: 60, first_matched_at: 1_000_000 } )
            const no_match_ctx = make_context( { output: `all good now` } )

            should_fire_rule( rule, no_match_ctx, 1_030_000 )
            expect( rule.first_matched_at ).toBeNull()

            const match_again_ctx = make_context( { output: `error returned` } )
            should_fire_rule( rule, match_again_ctx, 1_040_000 )
            expect( rule.first_matched_at ).toBe( 1_040_000 )
        } )

    } )

    describe( `idle rules`, () => {

        it( `fires when evaluate_rule says idle_seconds >= timeout`, () => {
            const rule = make_rule( {
                on: { type: `idle` },
                timeout_s: 30,
            } )
            const ctx = make_context( { idle_seconds: 30 } )
            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( true )
        } )

        it( `does not double-time-gate idle rules`, () => {

            // Idle rules already use the IdleTracker for timing. Running the
            // first_matched_at check on top would require a second timeout
            // window after evaluate_rule returns true — wrong behavior.
            const rule = make_rule( {
                on: { type: `idle` },
                timeout_s: 30,
            } )
            const ctx = make_context( { idle_seconds: 30 } )

            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( true )
            // first_matched_at should NOT be set for idle rules — the gating
            // is entirely inside evaluate_rule
            expect( rule.first_matched_at ).toBeNull()
        } )

        it( `does not fire when idle_seconds is below the timeout`, () => {
            const rule = make_rule( {
                on: { type: `idle` },
                timeout_s: 30,
            } )
            const ctx = make_context( { idle_seconds: 10 } )
            expect( should_fire_rule( rule, ctx, 1_000_000 ) ).toBe( false )
        } )

    } )

    describe( `debounce`, () => {

        it( `suppresses re-fire within DEBOUNCE_MS`, () => {

            // Debounce is the redraw-flicker guard. Without it, a TUI redraw
            // can produce two captures in a row that both contain the match,
            // and we'd send the action twice.
            const rule = make_rule( { last_fired_at: 1_000_000 } )
            const ctx = make_context( { output: `error here` } )

            const within = 1_000_000 + DEBOUNCE_MS - 100
            expect( should_fire_rule( rule, ctx, within ) ).toBe( false )
        } )

        it( `allows re-fire after DEBOUNCE_MS has elapsed`, () => {
            const rule = make_rule( { last_fired_at: 1_000_000 } )
            const ctx = make_context( { output: `error here` } )

            const after = 1_000_000 + DEBOUNCE_MS + 100
            expect( should_fire_rule( rule, ctx, after ) ).toBe( true )
        } )

    } )

} )
