import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { cmd_recover } from '../src/cli/recover.js'

const cleanups = []
const initial_exit_code = process.exitCode
afterEach( () => {
    cleanups.splice( 0 ).reverse().forEach( cleanup => cleanup() )
    process.exitCode = initial_exit_code ?? 0
} )

const fixture = ( invalid_files = [] ) => {

    const sessions = [
        { babysit_id: `old`, superseded_by: `current`, expected_open: true },
        { babysit_id: `closed`, expected_open: false },
        { babysit_id: `current`, resumed_from: `old`, expected_open: true },
        { babysit_id: `legacy` },
    ]
    const calls = []
    const lines = []
    const output = spyOn( console, `log` ).mockImplementation( line => lines.push( line ) )
    cleanups.push( () => output.mockRestore() )

    return {
        calls, lines,
        dependencies: {
            inspect: () => ( { records: sessions.map( session => ( { session } ) ), invalid_files } ),
            recover: async ( session, flags ) => {
                calls.push( { id: session.babysit_id, flags } )
                return { id: session.babysit_id, status: flags.dry_run ? `recoverable` : `recovered` }
            },
        },
    }

}

describe( `numbered recovery commands`, () => {

    it( `numbers exactly the global sweep, excluding superseded and closed launches`, async () => {
        const f = fixture( [ `broken.json` ] )
        await cmd_recover( { flags: { dry_run: true } }, f.dependencies )
        expect( f.calls.map( call => call.id ) ).toEqual( [ `current`, `legacy` ] )
        expect( f.lines ).toEqual( [
            `broken.json: blocked — Malformed session record`,
            `1. current: recoverable`,
            `2. legacy: recoverable`,
        ] )
    } )

    it( `selects the displayed number and preserves recovery flags`, async () => {
        const f = fixture()
        const flags = { dry_run: true, no_continue: true }
        await cmd_recover( { session_id: `2`, flags }, f.dependencies )
        expect( f.calls ).toEqual( [ { id: `legacy`, flags } ] )
        expect( f.lines ).toEqual( [ `2. legacy: recoverable` ] )
    } )

    it( `resolves old IDs to their current launch and retains its global number`, async () => {
        const f = fixture()
        await cmd_recover( { session_id: `old`, flags: {} }, f.dependencies )
        expect( f.calls.map( call => call.id ) ).toEqual( [ `current` ] )
        expect( f.lines ).toEqual( [ `1. current: recovered` ] )
    } )

    it( `still accepts intentionally closed launches by explicit ID`, async () => {
        const f = fixture()
        await cmd_recover( { session_id: `closed`, flags: {} }, f.dependencies )
        expect( f.calls.map( call => call.id ) ).toEqual( [ `closed` ] )
        expect( f.lines ).toEqual( [ `closed: recovered` ] )
    } )

    for( const selector of [ `0`, `3`, `999999999999999999999999999999999999999999` ] ) {
        it( `rejects ordinal ${ selector } before any recovery`, async () => {
            const f = fixture()
            await expect( cmd_recover( { session_id: selector, flags: {} }, f.dependencies ) ).rejects.toThrow( `No recovery session numbered ${ selector }` )
            expect( f.calls ).toEqual( [] )
        } )
    }

    it( `keeps JSON results free of display numbering`, async () => {
        const f = fixture()
        const chunks = []
        const stdout = spyOn( process.stdout, `write` ).mockImplementation( chunk => {
            chunks.push( chunk )
            return true
        } )
        cleanups.push( () => stdout.mockRestore() )
        const results = await cmd_recover( { session_id: `1`, flags: { dry_run: true, json: true } }, f.dependencies )
        expect( results ).toEqual( [ { id: `current`, status: `recoverable` } ] )
        expect( JSON.parse( chunks.join( `` ) ) ).toEqual( results )
        expect( f.lines ).toEqual( [] )
    } )

} )
