import { describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
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

    it( `keeps multiline diagnostics separate from the live TTY line`, () => {

        const source = `
            import { run_auth_checks_with_progress } from './src/cli/auth_progress.js'
            import { log } from './src/utils/log.js'

            const output = {
                isTTY: true,
                write: chunk => process.stdout.write( chunk ),
            }

            await run_auth_checks_with_progress(
                [ { name: 'codex' } ],
                async () => {
                    log.debug( 'Workspace mount disabled\\nfor docker command' )
                    return [ { name: 'codex', status: 'authenticated', authenticated: true } ]
                },
                { output, allow_skip: false }
            )

            log.debug( 'after progress' )
        `
        const result = spawnSync( `node`, [ `--input-type=module`, `--eval`, source ], {
            cwd: process.cwd(),
            encoding: `utf8`,
            env: {
                ...process.env,
                LOG_LEVEL: `debug`,
                TERM: `xterm-256color`,
            },
        } )

        expect( result.status ).toBe( 0 )
        expect( result.stdout ).toContain(
            `codex ⠋ preparing\r\x1b[2K🐛  Workspace mount disabled\nfor docker command\n\r\x1b[2KChecking authentication`
        )
        expect( result.stdout ).not.toContain( `preparing🐛` )
        expect( result.stdout ).toEndWith(
            `Authentication checks complete: codex authenticated\n🐛  after progress\n`
        )

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
        await expect( task ).resolves.toEqual( {
            results: [ {
                name: `codex`,
                status: `skipped`,
                authenticated: false,
            } ],
            skipped: true,
        } )

        expect( raw_modes ).toEqual( [ true, false ] )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        expect( input.isPaused() ).toBe( true )
        expect( timer.unref_calls ).toBe( 1 )
        expect( cleared_timers ).toEqual( [ timer ] )
        expect( rendered() ).toContain( `Authentication checks skipped: codex skipped` )

    } )

    it( `preserves input that was already flowing`, async () => {

        const { input } = fake_tty_input()
        const { output } = collect_output()

        input.resume()

        await run_auth_checks_with_progress(
            [ { name: `codex` } ],
            async () => [ { name: `codex`, status: `authenticated`, authenticated: true } ],
            { input, output, env: { TERM: `dumb` }, now: () => 1_000 }
        )

        expect( input.isPaused() ).toBe( false )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        input.pause()

    } )

    it( `restores fresh TTY input when progress setup fails`, async () => {

        const { input, raw_modes } = fake_tty_input()
        const { output } = collect_output( { is_tty: true } )

        await expect( run_auth_checks_with_progress(
            [ { name: `codex` } ],
            async () => [ { name: `codex`, status: `authenticated`, authenticated: true } ],
            {
                input,
                output,
                env: { TERM: `xterm-256color` },
                now: () => 1_000,
                set_interval: () => {
                    throw new Error( `timer setup failed` )
                },
            }
        ) ).rejects.toThrow( `timer setup failed` )

        expect( raw_modes ).toEqual( [ true, false ] )
        expect( input.isPaused() ).toBe( true )
        expect( input.listenerCount( `data` ) ).toBe( 0 )

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

        const batch = await run_auth_checks_with_progress(
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

        expect( batch.results[0].status ).toBe( `authenticated` )
        expect( batch.skipped ).toBe( false )
        expect( input.listenerCount( `data` ) ).toBe( 0 )
        expect( rendered() ).not.toContain( `press Enter to skip` )
        expect( rendered() ).not.toContain( `\x1b` )

    } )

    it( `keeps completed failures but marks the whole decision skipped`, async () => {

        const { input } = fake_tty_input()
        const { output, rendered } = collect_output()
        const failure_complete = deferred()
        const pending_cleanup = deferred()

        const task = run_auth_checks_with_progress(
            [ { name: `opencode` }, { name: `codex` } ],
            async ( { signal, on_state } ) => {
                on_state( `opencode`, `failed` )
                failure_complete.resolve()
                await new Promise( resolve_abort => signal.addEventListener( `abort`, resolve_abort, { once: true } ) )
                on_state( `codex`, `recovering credentials` )
                await pending_cleanup.promise
                return [
                    { name: `opencode`, status: `failed`, authenticated: false },
                    { name: `codex`, status: `skipped`, authenticated: false },
                ]
            },
            { input, output, env: { TERM: `dumb` }, now: () => 1_000 }
        )

        await failure_complete.promise
        input.write( `\n` )
        await new Promise( resolve => setImmediate( resolve ) )
        pending_cleanup.resolve()

        const batch = await task
        expect( batch.skipped ).toBe( true )
        expect( batch.results.map( result => result.status ) ).toEqual( [ `failed`, `skipped` ] )
        expect( rendered() ).toContain( `Authentication checks skipped` )
        expect( rendered() ).toContain( `opencode skipped, codex skipped` )
        expect( rendered() ).not.toContain( `Authentication checks skipped: opencode failed` )

    } )

    it( `keeps Enter as a batch skip when the final failure just completed`, async () => {

        const { input } = fake_tty_input()
        const { output, rendered } = collect_output()
        const grace_started = deferred()
        const release_grace = deferred()
        const task = run_auth_checks_with_progress(
            [ { name: `opencode` } ],
            async () => [ {
                name: `opencode`,
                status: `failed`,
                authenticated: false,
            } ],
            {
                input,
                output,
                env: { TERM: `dumb` },
                now: () => 1_000,
                wait_fn: async milliseconds => {
                    grace_started.resolve( milliseconds )
                    await release_grace.promise
                },
            }
        )

        expect( await grace_started.promise ).toBe( 150 )
        input.write( `\n` )
        release_grace.resolve()

        const batch = await task
        expect( batch.skipped ).toBe( true )
        expect( batch.results[0].status ).toBe( `failed` )
        expect( rendered() ).toContain( `Authentication checks skipped: opencode skipped` )
        expect( rendered() ).not.toContain( `Authentication checks skipped: opencode failed` )

    } )

} )
