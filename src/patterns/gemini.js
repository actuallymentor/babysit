// Gemini CLI plan/choice detection patterns

export const gemini_patterns = {

    plan: [
        /Review this plan/i,
        /approve the following/i,
        /Do you want to proceed/i,
    ],

    choice: [
        /\[y\/n\]/i,
        /Press Enter to continue/i,
        /approve/i,
    ],

}
