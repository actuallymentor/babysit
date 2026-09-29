// Strings in the installed Claude Code binary that Babysit's YOLO approval of
// the "Dangerous rm operation" prompt relies on (src/agents/claude.js).
// Required markers break the approver when missing; the rest change when or
// why YOLO sessions see the prompt.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'

export const CLAUDE_DIALOG_BINARY_CONTRACT = [
    { label: `reason template "Dangerous \${…} operation"`, pattern: /Dangerous \$\{\w+\} operation/, required: true },
    { label: `question "Do you want to proceed?"`, pattern: /Do you want to proceed\?/, required: true },
    { label: `footer "Esc to cancel · Tab to amend"`, pattern: /Esc to cancel/, required: true },
    { label: `dangerousRemoval is bypass-immune (why YOLO sees the prompt)`, pattern: /dangerousRemoval:\{bypassImmune:(?:!0|true)/, required: false },
    { label: `auto-deny countdown "will automatically deny this request in"`, pattern: /will automatically deny this request in/, required: false },
]

/** Resolve the installed `claude` executable, or null when absent. */
export const find_claude_binary = () => {
    try {
        return realpathSync( execFileSync( `which`, [ `claude` ], { encoding: `utf8` } ).trim() )
    } catch {
        return null
    }
}

/**
 * Check a Claude binary against the contract.
 * @param {string} binary - Resolved executable or cli.js path
 * @returns {{ passed: string[], missing: Array<{ label: string, required: boolean }> }}
 */
export const check_claude_binary = binary => {
    const text = readFileSync( binary ).toString( `latin1` )
    const passed = []
    const missing = []
    for( const { label, pattern, required } of CLAUDE_DIALOG_BINARY_CONTRACT ) {
        if( pattern.test( text ) ) passed.push( label )
        else missing.push( { label, required } )
    }
    return { passed, missing }
}
