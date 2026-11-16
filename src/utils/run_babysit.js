import { spawn } from 'node:child_process'

// Colors and cursor moves in the child's output
const ESCAPE_SEQUENCE_ALL = /\x1b\[[\d;]*[A-Za-z]/g

/**
 * Run a babysit command in the background, detached so it outlives its caller
 * (a restart takes minutes and kills the monitor that asked for it). Output is
 * collected, not shown; its first line is the result (errors lead, stack frames follow).
 * Shared by `babysit watch` shortcuts and web bridge actions.
 * @param {string[]} args - babysit arguments
 * @returns {Promise<{ ok: boolean, out: string }>}
 */
export const run_babysit = args => new Promise( resolve => {

    // Bun-compiled binaries put a synthetic /$bunfs path in argv[1]; node puts the script
    const script = process.argv[1] || ``
    const compiled = script.startsWith( `/$bunfs` ) || script === ``
    const child = spawn( process.execPath, compiled ? args : [ script, ...args ], { detached: true, stdio: [ `ignore`, `pipe`, `pipe` ] } )

    let output = ``
    const collect = chunk => output += chunk
    child.stdout.on( `data`, collect )
    child.stderr.on( `data`, collect )
    child.on( `error`, error => resolve( { ok: false, out: error.message } ) )
    child.on( `close`, code => resolve( { ok: code === 0, out: output.replace( ESCAPE_SEQUENCE_ALL, `` ).trim().split( `\n` )[0] || `` } ) )
    child.unref()

} )
