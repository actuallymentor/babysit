// Gemini CLI plan/choice detection patterns
//
// Gemini does NOT have a structured plan-acceptance UI like claude or codex.
// When asked to make a plan, gemini renders the plan as plain markdown in
// the chat and asks a free-form question like "Would you like me to proceed?"
// We match on those phrasings for `on: plan`.
//
// Choice patterns cover the structured prompts gemini DOES show: the trust
// dialog ("Trust folder"), the auth picker ("Sign in with Google"), and
// any tool-call confirmation ("Allow execution?").
//
// Reproduced via:
//   babysit gemini --no-update
//   > "Make a written plan to research the best implementation of bubble
//      sort in JavaScript. Then ask if I want to proceed."

export const gemini_patterns = {

    plan: [
        // Free-form "is this OK?" phrasings gemini produces at the end of a
        // plan. None are perfectly unique to plan mode, so put more specific
        // ones first.
        /Would you like me to proceed/i,
        /Shall I proceed with (this|the) (plan|research|implementation)/i,
        /(Approve|Confirm) (the|this) plan/i,
    ],

    choice: [
        // Structured choice prompts gemini uses at startup and for tool
        // approvals. The bullet glyph "●" before "1." is what every gemini
        // numbered prompt opens with.
        /● 1\.\s+\w+/,
        /Trust folder \(workspace\)/i,
        /Sign in with Google/i,
        /Allow execution\?/i,
        /Press Enter to (confirm|continue)/i,
        // Generic Y/N.
        /\[y\/n\]/i,
    ],

}
