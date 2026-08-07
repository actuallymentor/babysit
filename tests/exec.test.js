import { describe, expect, it } from 'bun:test'

import { run } from '../src/utils/exec.js'

describe( `async command runner`, () => {

    it( `terminates and rejects commands that exceed their deadline`, async () => {
        try {
            await run(
                process.execPath,
                [ `-e`, `setInterval(() => {}, 1000)` ],
                {},
                20
            )
            throw new Error( `expected timeout` )
        } catch ( error ) {
            expect( error.message ).toContain( `timed out after 20ms` )
            expect( error.code ).toBe( `ETIMEDOUT` )
        }
    } )

    it( `waits for an aborted child to close before rejecting`, async () => {

        const controller = new AbortController()
        const task = run(
            process.execPath,
            [ `-e`, `setInterval(() => {}, 1000)` ],
            { signal: controller.signal },
            1_000
        )

        controller.abort()
        await expect( task ).rejects.toThrow()

    } )

} )
