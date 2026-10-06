import { describe, expect, it } from 'bun:test'
import { cmd_archive, select_active_session } from '../src/cli/archive.js'
import { cmd_open } from '../src/cli/open.js'
import { cmd_close } from '../src/cli/recover.js'
import { order_active_sessions, print_active_sessions_table } from '../src/cli/list.js'
import { parse_args } from '../src/cli/parse.js'

// Two workspaces, three sessions; the middle one is archived.
const tmux = [
    { name: `babysit_a1`, attached: false, agent_status: `running` },
    { name: `babysit_a2`, attached: false, agent_status: `idle` },
    { name: `babysit_b1`, attached: false, agent_status: `idle` },
]
const stored = [
    { tmux_session: `babysit_a1`, babysit_id: `a1`, name: `alpha one`, agent: `codex`, pwd: `/w/alpha`, archived_at: `2026-10-06T10:00:00.000Z` },
    { tmux_session: `babysit_a2`, babysit_id: `a2`, name: `alpha two`, agent: `codex`, pwd: `/w/alpha` },
    { tmux_session: `babysit_b1`, babysit_id: `b1`, name: `beta one`, agent: `claude`, pwd: `/w/beta` },
]

const capture = async render => {
    const original = console.log
    const lines = []
    console.log = ( ...args ) => lines.push( args.join( ` ` ) )
    try {
        await render()
    } finally {
        console.log = original
    }
    return lines.join( `\n` )
}

describe( `archived sessions`, () => {

    it( `sink to the bottom of their workspace, and fully archived workspaces sink to the bottom`, () => {
        expect( order_active_sessions( tmux, stored ).map( session => session.name ) ).toEqual( [ `babysit_a2`, `babysit_a1`, `babysit_b1` ] )

        const all_alpha_archived = stored.map( session => session.babysit_id === `a2` ? { ...session, archived_at: `2026-10-06T11:00:00.000Z` } : session )
        expect( order_active_sessions( tmux, all_alpha_archived ).map( session => session.name ) ).toEqual( [ `babysit_b1`, `babysit_a1`, `babysit_a2` ] )
    } )

    it( `render dimmed, trunk included when every session in it is archived`, async () => {
        const previous = process.env.FORCE_COLOR
        process.env.FORCE_COLOR = `1`
        try {
            const all_alpha_archived = stored.map( session => session.pwd === `/w/alpha` ? { ...session, archived_at: `2026-10-06T11:00:00.000Z` } : session )
            const ordered = order_active_sessions( tmux, all_alpha_archived )
            const output = await capture( () => print_active_sessions_table( ordered, all_alpha_archived, { numbered: true } ) )
            const lines = output.split( `\n` )
            expect( lines.find( line => line.includes( `w/alpha` ) ) ).toContain( `\x1b[2;38;5;242m` )
            expect( lines.find( line => line.includes( `w/beta` ) ) ).not.toContain( `\x1b[2;38;5;242m` )
            expect( lines.find( line => line.includes( `alpha one` ) ) ).toMatch( /^\s*\x1b\[2;38;5;242m.*alpha one/ )
            expect( lines.find( line => line.includes( `beta one` ) ) ).toContain( `\x1b[38;5;245midle` )
            // Numbers follow the displayed order: beta first
            expect( lines.find( line => line.includes( `beta one` ) ) ).toMatch( /└─ 1\s+beta one/ )
        } finally {
            if( previous === undefined ) delete process.env.FORCE_COLOR
            else process.env.FORCE_COLOR = previous
        }
    } )

    it( `archive resolves list numbers in display order, ids and unique names`, async () => {
        const ordered = order_active_sessions( tmux, stored )
        expect( select_active_session( `1`, ordered, stored ).babysit_id ).toBe( `a2` )
        expect( select_active_session( `b1`, ordered, stored ).babysit_id ).toBe( `b1` )
        expect( select_active_session( `beta one`, ordered, stored ).babysit_id ).toBe( `b1` )
        expect( () => select_active_session( `9`, ordered, stored ) ).toThrow( /numbered 9/ )
        expect( () => select_active_session( `nobody`, ordered, stored ) ).toThrow( /No active session/ )

        const updates = []
        const messages = []
        await cmd_archive( { session_id: `1` }, {
            list_sessions_fn: async () => tmux,
            list_stored_sessions_fn: () => stored,
            update_session_fn: ( id, changes ) => updates.push( [ id, Object.keys( changes ) ] ),
            print: message => messages.push( message ),
        } )
        expect( updates ).toEqual( [ [ `a2`, [ `archived_at` ] ] ] )
        expect( messages[0] ).toContain( `Archived alpha two` )

        await cmd_archive( { session_id: `a1` }, {
            list_sessions_fn: async () => tmux,
            list_stored_sessions_fn: () => stored,
            update_session_fn: () => {
                throw new Error( `must not rewrite an archived session` )
            },
            print: message => messages.push( message ),
        } )
        expect( messages[1] ).toContain( `already archived` )
    } )

    it( `open un-archives and numbers the displayed order; close numbers it too`, async () => {
        const updates = []
        let attached = null
        await cmd_open( { session_id: `2` }, {
            has_session_fn: async () => false,
            list_sessions_fn: async () => tmux,
            list_stored_sessions_fn: () => stored,
            attach_session_fn: name => {
                attached = name
            },
            list_after_attach_fn: async () => {},
            update_session_fn: ( id, changes ) => updates.push( [ id, changes ] ),
            exit_fn: code => {
                throw new Error( `Unexpected exit ${ code }` )
            },
        } )
        expect( attached ).toBe( `babysit_a1` )
        expect( updates ).toEqual( [ [ `a1`, { archived_at: null } ] ] )

        const closed = []
        await cmd_close( { session_id: `2` }, {
            inspect_records: () => ( { records: stored.map( session => ( { session } ) ) } ),
            sessions: async () => tmux,
            close: async session => closed.push( session.babysit_id ),
            print: () => {},
        } )
        expect( closed ).toEqual( [ `a1` ] )
    } )

    it( `parses the archive verb with a required selector`, () => {
        expect( parse_args( [ `archive`, `3` ] ) ).toMatchObject( { verb: `archive`, session_id: `3` } )
        expect( () => parse_args( [ `archive` ] ) ).toThrow( /Usage: babysit archive/ )
    } )

} )
