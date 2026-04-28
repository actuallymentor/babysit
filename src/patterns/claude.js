// Claude Code plan/choice detection patterns
// Plan acceptance changed post-v2.1: accept is Shift+Tab (\x1b[Z), NOT Enter

export const claude_patterns = {

    plan: [
        /needs your approval/i,
        /Do you want to proceed/i,
        /Plan mode is active/i,
        /approve this plan/i,
    ],

    choice: [
        /\? for shortcuts/,
        /Yes.*No.*Always/,
        /Allow.*Deny/i,
        /\(y\/n\)/i,
        /Press Enter to/i,
    ],

}
