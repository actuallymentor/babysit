// OpenCode plan/choice detection patterns
//
// Opencode has a "Plan" agent (Tab-cycle from "Build" to "Plan" in the
// status bar), but unlike claude/codex the planning output is plain chat
// markdown — opencode does NOT pop a structured "Accept this plan?" dialog.
// Plan acceptance is just the model asking via a free-form question.
//
// The status-bar marker "Plan · <model>" is a reliable signal that opencode
// is currently in the plan agent — useful for `on: plan` to distinguish a
// pending plan question from a regular chat reply.
//
// Reproduced via:
//   babysit opencode --no-update
//   > <press Tab to switch to Plan agent>
//   > "Make a plan to research the best implementation of bubble sort in
//      JavaScript. Then ask if I want to proceed."

export const opencode_patterns = {

    plan: [
        // Free-form proceed prompts opencode emits at the end of a plan.
        /Would you like me to proceed/i,
        /Do you want me to proceed/i,
        /Shall I proceed with (this|the) (plan|research|implementation)/i,
        // Plan-agent status marker in the bottom bar. Not unique to "ready
        // for acceptance" but combined with idle it's a strong signal.
        /^\s*Plan · /m,
    ],

    choice: [
        // Tool/permission prompts opencode shows inline. The CLI uses ANSI
        // arrow markers that survive ANSI stripping as plain ASCII.
        /\[y\/n\]/i,
        /\(y\/N\)/,
        /\(Y\/n\)/,
        /Press (enter|return) to/i,
    ],

}
