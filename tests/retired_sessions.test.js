import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { cmd_start } from '../src/cli/start.js'
import { recovery_blocker, recover_session } from '../src/cli/recover.js'

const diagnostic = `Gemini CLI sessions are no longer supported and cannot resume in Antigravity`

describe( `retired Gemini sessions`, () => {

    it( `rejects old launches and attempts to resume their IDs with Antigravity`, async () => {
        for( const agent of [ `gemini`, `antigravity` ] ) {
            await expect( cmd_start( {
                agent, stored_session: { agent: `gemini`, babysit_id: `old-session` },
                flags: {}, passthrough: [],
            } ) ).rejects.toThrow( diagnostic )
        }
    } )

    it( `explains incompatibility before legacy recovery or monitor repair`, async () => {
        const session = { agent: `gemini`, babysit_id: `old-session` }
        expect( recovery_blocker( session ) ).toContain( diagnostic )
        const result = await recover_session( session, {}, {
            load: () => session,
            lock: () => () => {},
            identity: () => {
                throw new Error( `Must not inspect Docker for a retired agent` )
            },
        } )
        expect( result.status ).toBe( `skipped` )
        expect( result.reason ).toContain( diagnostic )
    } )

    it( `fails a restarted monitor before overwriting session state`, () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-retired-monitor-` ) )
        const sessions = join( directory, `sessions` )
        mkdirSync( sessions )
        const session = { agent: `gemini`, babysit_id: `old-session`, status: `interrupted` }
        writeFileSync( join( sessions, `old-session.json` ), JSON.stringify( session ) )
        try {
            const module = new URL( `../src/cli/monitor.js`, import.meta.url ).href
            const result = spawnSync( process.execPath, [ `--input-type=module`, `-e`, `
                import { cmd_monitor } from ${ JSON.stringify( module ) }
                import { readFileSync } from 'node:fs'
                try { await cmd_monitor({ session_id: 'old-session' }) }
                catch (error) { console.log(error.message) }
                console.log(readFileSync(${ JSON.stringify( join( sessions, `old-session.json` ) ) }, 'utf8'))
            ` ], { env: { ...process.env, BABYSIT_HOME: directory }, encoding: `utf8`, timeout: 10_000 } )
            expect( result.status ).toBe( 0 )
            expect( result.stdout ).toContain( diagnostic )
            expect( JSON.parse( result.stdout.trim().split( `\n` ).at( -1 ) ) ).toEqual( session )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }
    } )

} )
