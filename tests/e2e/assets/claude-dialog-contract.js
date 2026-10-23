// Strings in the installed Claude Code binary that Babysit's YOLO dialog
// approval relies on (src/agents/claude.js). Required markers break the
// approver when missing; the rest change when or why YOLO sessions see a prompt.
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'

export const CLAUDE_DIALOG_BINARY_CONTRACT = [
    { label: `reason template "Dangerous \${…} operation"`, pattern: /Dangerous \$\{\w+\} operation/, required: false },
    { label: `shell -c reason "This shell -c script runs rm and could not be checked"`, pattern: /This shell -c script runs rm and could not be checked/, required: false },
    { label: `question "Do you want to proceed?"`, pattern: /Do you want to proceed\?/, required: false },
    { label: `footer "Esc to cancel · Tab to amend"`, pattern: /Esc to cancel/, required: true },
    { label: `dangerousRemoval is bypass-immune (why YOLO sees the prompt)`, pattern: /dangerousRemoval:\{bypassImmune:(?:!0|true)/, required: false },
    { label: `auto-deny countdown "will automatically deny this request in"`, pattern: /will automatically deny this request in/, required: false },
]

// Shell shims (Babysit's /opt/babysit-bin/claude) only forward to the real
// claude; a Node cli.js shebang is the real thing. Read only the header: the binary is ~300 MB.
const is_shell_shim = path => {
    const header = Buffer.alloc( 64 )
    const fd = openSync( path, `r` )
    try {
        const bytes = readSync( fd, header, 0, header.length, 0 )
        return /^#![^\n]*\b(?:ba|z|da)?sh\b/.test( header.subarray( 0, bytes ).toString() )
    } finally {
        closeSync( fd )
    }
}

/** Resolve the installed `claude` executable past any shell shim, or null when absent. */
export const find_claude_binary = () => {
    try {
        const paths = execFileSync( `which`, [ `-a`, `claude` ], { encoding: `utf8` } ).split( `\n` ).filter( Boolean )
        return paths.map( path => realpathSync( path ) ).find( path => !is_shell_shim( path ) ) || null
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
