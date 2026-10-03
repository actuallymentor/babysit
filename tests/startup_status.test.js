import { describe, expect, it } from 'bun:test'
import { PassThrough } from 'stream'

import { format_startup_status_line, start_startup_status } from '../src/cli/startup_status.js'
import { log } from '../src/utils/log.js'

const terminal = ( is_tty = true ) => {
    const output = new PassThrough()
    let rendered = ``
    output.isTTY = is_tty
    output.on( `data`, chunk => rendered += chunk.toString() )
    return { output, rendered: () => rendered }
}

describe( `startup status line`, () => {

    it( `names the phase and its elapsed time`, () => {

        expect( format_startup_status_line( `Starting claude`, `loading credentials`, {
            started_at: 1_000,
            now: 3_500,
            frame: `⠋`,
        } ) ).toBe( `⠋ Starting claude: loading credentials 2.5s` )

    } )

    it( `redraws each phase on a TTY and clears when paused`, async () => {

        const { output, rendered } = terminal()
        let current = 0
        const timers = []
        const status = start_startup_status( `Starting codex`, {
            output,
            env: { TERM: `xterm-256color` },
            now: () => current,
            set_interval: ( callback ) => {
                timers.push( callback )
                return { unref: () => {} }
            },
            clear_interval: () => timers.length = 0,
        } )

        status.set( `loading credentials` )
        current = 1_200
        timers[0]()
        status.set( `checking cached authentication` )
        status.pause()
        await new Promise( resolve => setTimeout( resolve, 0 ) )

        expect( rendered() ).toContain( `Starting codex: loading credentials 0.0s` )
        expect( rendered() ).toContain( `Starting codex: loading credentials 1.2s` )
        expect( rendered() ).toContain( `Starting codex: checking cached authentication 0.0s` )
        expect( rendered() ).toEndWith( `\r\x1b[2K` )
        expect( timers ).toEqual( [] )

    } )

    it( `keeps diagnostics on their own line while the status is live`, async () => {

        const { output, rendered } = terminal()
        const status = start_startup_status( `Starting codex`, { output, env: { TERM: `xterm-256color` }, now: () => 0 } )
        const original_level = log.loglevel

        status.set( `preparing container` )
        log.warn( `Slow startup phase: preparing container took 6.0s` )
        status.stop()
        await new Promise( resolve => setTimeout( resolve, 0 ) )

        // The live line is cleared before the warning and redrawn afterwards.
        expect( rendered() ).toMatch( /preparing container 0\.0s\r\x1b\[2K[\s\S]*\r\x1b\[2K. Starting codex: preparing container 0\.0s\r\x1b\[2K$/ )
        log.loglevel = original_level

    } )

    it( `stays silent off a TTY`, async () => {

        const { output, rendered } = terminal( false )
        const status = start_startup_status( `Starting codex`, { output } )

        status.set( `loading credentials` )
        status.stop()
        await new Promise( resolve => setTimeout( resolve, 0 ) )

        expect( rendered() ).toBe( `` )

    } )

} )
