// Codex CLI plan/choice detection patterns

export const codex_patterns = {

    plan: [
        /Approve this command/i,
        /Approve this action/i,
        /Review the plan/i,
    ],

    choice: [
        /\[y\/n\]/i,
        /approve/i,
        /confirm/i,
    ],

}
