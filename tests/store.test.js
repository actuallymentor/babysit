import { describe, it, expect } from 'bun:test'
import { rmSync } from 'fs'
import { join } from 'path'
import {
    load_session,
    save_session,
    sort_sessions_newest_first,
} from '../src/sessions/store.js'
import { SESSIONS_DIR } from '../src/utils/paths.js'

describe( `stored session ordering`, () => {

    it( `sorts session history newest first without mutating its input`, () => {

        const sessions = [
            { babysit_id: `older`, started_at: `2026-08-03T12:00:00.000Z` },
            { babysit_id: `legacy` },
            { babysit_id: `invalid`, started_at: `unknown` },
            { babysit_id: `newer`, started_at: `2026-08-04T12:00:00.000Z` },
        ]

        const sorted = sort_sessions_newest_first( sessions )

        expect( sorted.map( session => session.babysit_id ) ).toEqual( [ `newer`, `older`, `legacy`, `invalid` ] )
        expect( sessions.map( session => session.babysit_id ) ).toEqual( [ `older`, `legacy`, `invalid`, `newer` ] )

    } )

    it( `resolves duplicate native ids to the newest Babysit launch`, () => {

        const suffix = `${ process.pid }-${ Date.now() }`
        const native_id = `native-${ suffix }`
        const older_id = `store-test-older-${ suffix }`
        const newer_id = `store-test-newer-${ suffix }`
        const session_path = id => join( SESSIONS_DIR, `${ id }.json` )

        try {
            save_session( {
                babysit_id: older_id,
                agent: `codex`,
                agent_session_id: native_id,
                tmux_session: `older`,
                pwd: `/workspace/older`,
                modifiers: [],
                started_at: `2026-08-03T12:00:00.000Z`,
            } )
            save_session( {
                babysit_id: newer_id,
                agent: `codex`,
                agent_session_id: native_id,
                tmux_session: `newer`,
                pwd: `/workspace/newer`,
                modifiers: [],
                started_at: `2026-08-04T12:00:00.000Z`,
            } )

            expect( load_session( native_id )?.babysit_id ).toBe( newer_id )
            expect( load_session( older_id )?.babysit_id ).toBe( older_id )
        } finally {
            rmSync( session_path( older_id ), { force: true } )
            rmSync( session_path( newer_id ), { force: true } )
        }

    } )

} )
