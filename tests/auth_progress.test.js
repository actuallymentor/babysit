import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'stream'

import {
    format_auth_progress_line,
    run_auth_checks_with_progress,
} from '../src/cli/auth_progress.js'

const deferred = () => {

    let resolve
    const promise = new Promise( resolve_promise => {
        resolve = resolve_promise
    } )

    return { promise, resolve }

}

const collect_output = ( { is_tty = false } = {} ) => {

    const output = new PassThrough()
    let rendered = ``

    output.isTTY = is_tty
    output.on( `data`, chunk => rendered += chunk.toString() )

    return { output, rendered: () => rendered }

}

const fake_tty_input = ( { paused = false } = {} ) => {

    const input = new PassThrough()
    const raw_modes = []

    input.isTTY = true
    input.isRaw = false
    input.setRawMode = raw => {
        raw_modes.push( raw )
        input.isRaw = raw
    }
    if( paused ) input.pause()

    return { input, raw_modes }

}

describe( `authentication progress`, () => {

    it( `formats compact Unicode and plain progress lines`, () => {

        const states = new Map( [
            [ `codex`, `checking` ],
            [ `claude`, `authenticated` ],
        ] )

        expect( format_auth_progress_line( states, {
            started_at: 1_000,
            now: 2_500,
            frame: `⠙`,
            unicode: true,
            allow_skip: true,
        } ) ).toBe( `Checking authentication 1.5s — press Enter to skip — codex ⠙ checking, claude ✓` )

        expect( format_auth_progress_line( states, {
            started_at: 1_000,
            now: 2_500,
            unicode: false,
            allow_skip: false,
        } ) ).toBe( `Checking authentication 1.5s — codex ... checking, claude ok` )

    } )

    it( `acknowledges Enter immediately but waits for safe cleanup before resolving`, async () => {

        const { input, raw_modes } = fake_tty_input()
        const { output, rendered } = collect_output( { is_tty: true } )
        const check_started = deferred()
        const cleanup = deferred()
        const cleared_timers = []
        const timer = {
            unref_calls: 0,
            unref() {
                this.unref_calls += 1
            },
        }

        const task = run_auth_checks_with_progress(
            [ { name: `codex` } ],
            async ( { signal } ) => {
                check_started.resolve( signal )
                await new Promise( resolve_abort => signal.addEventListener( `abort`, resolve_abort, { once: true } ) )
                await cleanup.promise
                return [ { name: `codex`, status: `skipped`, authenticated: false } ]
            },
            {
                input,
                output,
                env: { TERM: `xterm-256color` },
                now: () => 1_000,
                set_interval: () => timer,
                clear_interval: value => cleared_timers.push( value ),
            }
        )

        const signal = await check_started.promise
        input.write( `\n` )
        await new Promise( resolve => setImmediate( resolve ) )

        expect( signal.aborted ).toBe( true )
        expect( signal.reason ).toEqual( { code: `skip` } )
        expect( rendered() ).toContain( `Skipping authentication checks; cleaning up...` )

        let settled = false
        task.finally( () => settled = true )
        await Promise.resolve()
        expect( settled ).toBe( false )

        cleanup.resolve()
        await expect( task ).resolves.toEqual( [ {
            name: `codex`,
            status: `skipped`,
            authenticated: false,
        } ] )

        expect( raw_modes ).toEqual( [ true, false ] )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        expect( timer.unref_calls ).toBe( 1 )
        expect( cleared_timers ).toEqual( [ timer ] )
        expect( rendered() ).toContain( `Authentication checks skipped: codex skipped` )

    } )

    it( `restores paused/raw input and forwards Ctrl+C after cleanup`, async () => {

        const { input, raw_modes } = fake_tty_input( { paused: true } )
        const { output } = collect_output()
        const check_started = deferred()
        const cleanup = deferred()
        const kill_calls = []

        const task = run_auth_checks_with_progress(
            [ { name: `codex` } ],
            async ( { signal } ) => {
                check_started.resolve( signal )
                await new Promise( resolve_abort => signal.addEventListener( `abort`, resolve_abort, { once: true } ) )
                await cleanup.promise
                return [ { name: `codex`, status: `cancelled`, authenticated: false } ]
            },
            {
                input,
                output,
                env: { TERM: `dumb` },
                now: () => 1_000,
                kill_process: ( pid, signal ) => kill_calls.push( { pid, signal } ),
            }
        )

        const signal = await check_started.promise
        input.write( `\x03` )
        await new Promise( resolve => setImmediate( resolve ) )

        expect( signal.reason ).toEqual( { code: `interrupt` } )
        expect( kill_calls ).toEqual( [] )

        cleanup.resolve()
        await task

        expect( raw_modes ).toEqual( [ true, false ] )
        expect( input.isPaused() ).toBe( true )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        expect( kill_calls ).toEqual( [ { pid: process.pid, signal: `SIGINT` } ] )

    } )

    it( `never reads non-TTY input or starts an animation timer`, async () => {

        const input = new PassThrough()
        const { output, rendered } = collect_output()

        input.isTTY = false
        input.setRawMode = () => {
            throw new Error( `unexpected raw mode` )
        }

        const results = await run_auth_checks_with_progress(
            [ { name: `codex` } ],
            async () => [ { name: `codex`, status: `authenticated`, authenticated: true } ],
            {
                input,
                output,
                env: { TERM: `xterm-256color` },
                now: () => 1_000,
                set_interval: () => {
                    throw new Error( `unexpected animation` )
                },
            }
        )

        expect( results[0].status ).toBe( `authenticated` )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        expect( rendered() ).not.toContain( `press Enter to skip` )
        expect( rendered() ).not.toContain( `\x1b` )

    } )

} )
