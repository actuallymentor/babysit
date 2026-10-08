import { expect, it } from 'bun:test'
import { EXIT_CONFIRMATION, run_exit } from '../src/docker/assets/effort/command.mjs'

// Never let these tests reach the real control store: inside a managed session
// that would queue a genuine exit and close the session running the suite.
const stub = () => {
    const calls = []
    const request = async ( operation, help, args ) => {
        calls.push( [ operation, args ] )
        return `requested`
    }
    return { calls, request }
}

it( `asks before exiting and proceeds on Y, yes, or Enter`, async () => {
    for( const answer of [ ``, `y`, `Y`, `yes` ] ) {
        const { calls, request } = stub()
        let asked = null
        expect( await run_exit( [], { request, confirm: async question => {
            asked = question
            return answer
        } } ) ).toBe( `requested` )
        expect( asked ).toBe( EXIT_CONFIRMATION )
        expect( calls ).toEqual( [ [ `exit`, [] ] ] )
    }
} )

it( `cancels on n and refuses when stdin gives no answer`, async () => {
    const { calls, request } = stub()
    await expect( run_exit( [], { request, confirm: async () => `n` } ) ).rejects.toThrow( `Exit cancelled.` )
    await expect( run_exit( [], { request, confirm: async () => null } ) ).rejects.toThrow( `babysit exit --yes` )
    expect( calls ).toEqual( [] )
} )

it( `rejects --status without an id instead of queueing an exit`, async () => {
    const { calls, request } = stub()
    for( const args of [ [ `--status` ], [ `--status`, `--yes` ] ] ) {
        await expect( run_exit( args, { request, confirm: async () => `y` } ) ).rejects.toThrow( `Usage: babysit exit` )
    }
    expect( calls ).toEqual( [] )
} )

it( `skips the prompt for --yes, --help, and --status`, async () => {
    const { calls, request } = stub()
    let asked = 0
    const confirm = async () => {
        asked++
        return `n`
    }
    for( const args of [ [ `--help` ], [ `--yes` ], [ `-y` ], [ `--status`, `abc` ] ] ) {
        expect( await run_exit( args, { request, confirm } ) ).toBe( `requested` )
    }
    expect( asked ).toBe( 0 )
    expect( calls ).toEqual( [ [ `exit`, [ `--help` ] ], [ `exit`, [] ], [ `exit`, [] ], [ `exit`, [ `--status`, `abc` ] ] ] )
} )
