import { describe, it, expect } from 'bun:test'

import { matches_patterns } from '../src/babysit/matcher.js'
import { get_patterns } from '../src/patterns/index.js'
import { SUPPORTED_AGENTS } from '../src/agents/index.js'

// These fixtures are real captures from `babysit <agent> --no-update` followed
// by "enter planning mode and make a plan to research best implementation of
// bubble sort". Patterns that drift away from these will silently break
// `on: plan` rules in babysit.yaml. If a vendor changes their UI text, the
// fixture should be re-captured (see SPECIFICATION.md and run the agent
// manually to copy the new prompt text).

const FIXTURES = {

    claude: {
        plan_acceptance: `
 Claude has written up a plan and is ready to execute. Would you like to proceed?

 ❯ 1. Yes, and use auto mode
   2. Yes, manually approve edits
   3. No, refine with Ultraplan on Claude Code on the web
   4. Tell Claude what to change
      shift+tab to approve with this feedback

 ctrl-g to edit in Vim · ~/.claude/plans/playful-foraging-snowflake.md
`,
        tool_choice: `
 Bash command

   sudo chown -R node:node /home/node/.claude/plans/

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and allow access to plans/ and sudo chown commands
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
`,
        normal_chat_reply: `
● The current weather in Amsterdam is 18°C and partly cloudy.
This data is from a simulated source — for real-time, hit a weather API.
`,
    },

    codex: {
        plan_acceptance: `
  Implement this plan?

› 1. Yes, implement this plan          Switch to Default and start coding.
  2. Yes, clear context and implement  Fresh thread. Context: 1% used.
  3. No, stay in Plan mode             Continue planning with the model.

  Press enter to confirm or esc to go back
`,
        plan_status_bar: `
› Find and fix a bug in @filename

  gpt-5.5 medium · /workspace                                                           Plan mode (shift+tab to cycle)
`,
        normal_chat_reply: `
• OK


› Run /review on my current changes

  gpt-5.5 high · /workspace
`,
    },

    gemini: {
        plan_acceptance: `
✦ I will research and implement the most efficient and idiomatic Bubble Sort in JavaScript. Here is my proposed plan:

  ...

  Would you like me to proceed with this research?
`,
        normal_chat_reply: `
✦ The capital of France is Paris.
`,
    },

    opencode: {
        plan_acceptance: `
     4. Provide the recommended JavaScript implementation with:
        - Code
        - Complexity analysis

     Do you want me to proceed with the research and recommendation?

     ▣  Plan · GPT-5.5 · 4.4s
`,
        normal_chat_reply: `
     OK

     ▣  Build · GPT-5.5 · 1.1s
`,
    },

}

describe( `plan patterns match real prompt fixtures`, () => {

    // Iterate the live registry rather than hardcoding the agent list — a
    // fifth agent added to src/agents/index.js without a fixture here
    // should fail loudly, not silently skip pattern coverage.
    for ( const agent of SUPPORTED_AGENTS ) {

        it( `${ agent }: plan_acceptance fixture matches at least one plan pattern`, () => {
            const patterns = get_patterns( agent ).plan
            expect( matches_patterns( FIXTURES[ agent ].plan_acceptance, patterns ) ).toBe( true )
        } )

        it( `${ agent }: a normal chat reply does NOT match plan patterns`, () => {
            const patterns = get_patterns( agent ).plan
            expect( matches_patterns( FIXTURES[ agent ].normal_chat_reply, patterns ) ).toBe( false )
        } )

    }

} )

describe( `codex plan status-bar pattern`, () => {

    it( `matches the persistent "Plan mode (shift+tab to cycle)" status line`, () => {
        // Useful for `on: plan` to fire on idle when codex paused mid-planning,
        // before the final "Implement this plan?" prompt appears.
        expect( matches_patterns( FIXTURES.codex.plan_status_bar, get_patterns( `codex` ).plan ) ).toBe( true )
    } )

} )

describe( `claude tool-approval choice pattern`, () => {

    it( `matches the "Esc to cancel · Tab to amend" footer`, () => {
        // The plan acceptance prompt shows "ctrl-g to edit in Vim" instead.
        // We rely on the choice patterns to fire on the tool-approval flow.
        expect( matches_patterns( FIXTURES.claude.tool_choice, get_patterns( `claude` ).choice ) ).toBe( true )
    } )

} )
