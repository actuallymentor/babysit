// Codex CLI plan/choice detection patterns
//
// Patterns derived from observing codex v0.128 in plan mode (entered via
// `/plan`) and various approval prompts. Plan mode is a first-class feature
// and shows a structured "Implement this plan?" dialog when the model is
// done planning. The status bar carries a persistent "Plan mode" marker
// useful for matching idle-in-plan-mode states.
//
// Reproduced via:
//   babysit codex --no-update
//   > /plan
//   > "make a plan to research the best implementation of bubble sort in JS"

export const codex_patterns = {

    plan: [
        // Final plan-acceptance prompt — distinctive phrasing.
        /Implement this plan\?/i,
        /Yes, implement this plan/i,
        /Yes, clear context and implement/i,
        /No, stay in Plan mode/i,
        // Status-bar marker shown whenever plan mode is active.
        /Plan mode \(shift\+tab to cycle\)/i,
    ],

    choice: [
        // Numbered option list that codex uses for trust dialogs, model
        // intros, and command-approval prompts.
        /Press enter to confirm or esc/i,
        /Press enter to continue/i,
        // Generic shapes.
        /\[y\/n\]/i,
        /^› \d+\./m,
        /^❯ \d+\./m,
    ],

}
