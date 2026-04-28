// OpenCode plan/choice detection patterns

export const opencode_patterns = {

    plan: [
        /Review this plan/i,
        /Approve plan/i,
        /confirm before executing/i,
    ],

    choice: [
        /\[y\/n\]/i,
        /approve/i,
        /confirm/i,
    ],

}
