// Claude Code plan/choice detection patterns
//
// Patterns derived from observing claude v2.1 in plan mode and tool-approval
// flows. Plan acceptance is a numbered list (1/2/3/4) with the agent waiting
// on Enter; Shift+Tab is now reserved for "approve with feedback" (option 4),
// not the older direct-accept behavior.
//
// Reproduced via:
//   babysit claude --no-update
//   > "enter planning mode and make a plan to research X"
//   ... claude churns, then renders the prompt below.

export const claude_patterns = {

    plan: [
        // Final plan-acceptance prompt — the unique phrasing claude uses
        // once it has the plan written and is asking to switch out of plan mode.
        /Claude has written up a plan and is ready to execute/i,
        // Numbered "auto mode" options that only appear in the plan dialog
        // (won't collide with regular tool-approval prompts).
        /Yes, and use auto mode/i,
        /Yes, manually approve edits/i,
        /refine with Ultraplan/i,
        // Persistent status-bar marker visible while plan mode is active,
        // including before the prompt appears — useful for `on: plan` to
        // pre-fire on idle when claude paused mid-planning.
        /plan mode on \(shift\+tab to cycle\)/i,
    ],

    choice: [
        // Tool-approval dialogs use a "Do you want to proceed?" header
        // followed by numbered Yes/No options + a footer key hint.
        /Esc to cancel · Tab to amend/i,
        /❯ 1\. Yes/,
        // Generic Y/N choice prompts (legacy + new).
        /\(y\/n\)/i,
        /Press Enter to/i,
        // Status bar shown when claude is awaiting any input.
        /\? for shortcuts/,
    ],

}
