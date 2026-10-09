import { describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run only the gate section of the real entrypoint, with the gate path
// redirected into a temp dir so the test never needs root or Docker.
const run_gate = ( { env = {}, release_after_ms = null } = {} ) => new Promise( resolve => {
    const directory = mkdtempSync( join( tmpdir(), `babysit-gate-` ) )
    const gate = join( directory, `run`, `ready` )
    const source = readFileSync( new URL( `../src/docker/assets/entrypoint.sh`, import.meta.url ), `utf8` )
    const section = source.slice( 0, source.indexOf( `# UID remap` ) ).replace( `/run/babysit-bootstrap/ready`, gate )
    const script = join( directory, `gate.sh` )
    writeFileSync( script, `${ section }\necho released` )

    const child = spawn( `bash`, [ script ], { env: { ...process.env, ...env }, stdio: [ `ignore`, `pipe`, `pipe` ] } )
    let output = ``
    let errors = ``
    child.stdout.on( `data`, data => {
        output += data 
    } )
    child.stderr.on( `data`, data => {
        errors += data 
    } )
    child.once( `close`, code => resolve( { code, output: output.trim(), errors: errors.trim() } ) )

    if( release_after_ms !== null ) setTimeout( () => {
        mkdirSync( join( directory, `run` ), { recursive: true } )
        writeFileSync( gate, `` )
    }, release_after_ms )
} )

describe( `entrypoint bootstrap gate`, () => {

    it( `runs straight through without the gate flag`, async () => {
        expect( await run_gate() ).toEqual( { code: 0, output: `released`, errors: `` } )
    } )

    it( `waits for the release file`, async () => {
        const started = Date.now()
        const result = await run_gate( { env: { BABYSIT_BOOTSTRAP_WAIT: `1` }, release_after_ms: 300 } )
        expect( result ).toEqual( { code: 0, output: `released`, errors: `` } )
        expect( Date.now() - started ).toBeGreaterThanOrEqual( 250 )
    } )

    it( `gives up after the deadline instead of running the agent`, async () => {
        const result = await run_gate( { env: { BABYSIT_BOOTSTRAP_WAIT: `1`, BABYSIT_BOOTSTRAP_TIMEOUT_SECONDS: `1` } } )
        expect( result.code ).toBe( 1 )
        expect( result.output ).toBe( `` )
        expect( result.errors ).toContain( `bootstrap gate` )
    } )

} )
