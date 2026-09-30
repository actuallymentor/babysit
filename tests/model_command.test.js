import { expect, it } from 'bun:test'
import { run_model } from '../src/docker/assets/effort/command.mjs'

it( `appends a default 30-row benchmark listing after the available models`, async () => {
    const calls = []
    const output = await run_model( [], {
        control: async args => {
            calls.push( [ `control`, args ] )
            return `Available: model-one`
        },
        benchmarks: async args => {
            calls.push( [ `benchmarks`, args ] )
            return `Coding benchmarks`
        },
    } )
    expect( calls ).toEqual( [ [ `control`, [] ], [ `benchmarks`, [ `--benchmarks`, `--limit`, `30` ] ] ] )
    expect( output ).toBe( `Available: model-one\n\nCoding benchmarks` )
} )

it( `keeps the model list when the benchmark key is absent or the API fails`, async () => {
    for( const message of [ `Artificial analysis API key not set, could not get latest benchmarks`, `Could not get latest benchmarks` ] ) {
        const output = await run_model( [], {
            control: async () => `Available: model-one`,
            benchmarks: async () => {
                throw new Error( message ) 
            },
        } )
        expect( output ).toBe( `Available: model-one\n\n${ message }` )
    }
} )

it( `does not append benchmarks to switches, help, or queued-status queries`, async () => {
    for( const args of [ [ `model-one` ], [ `--help` ], [ `--status`, `request-id` ] ] ) {
        let benchmark_calls = 0
        expect( await run_model( args, {
            control: async () => `Control result`,
            benchmarks: async () => {
                benchmark_calls++; return `Benchmarks` 
            },
        } ) ).toBe( `Control result` )
        expect( benchmark_calls ).toBe( 0 )
    }
} )

it( `keeps explicit benchmark output and errors separate from model control`, async () => {
    let control_calls = 0
    const args = [ `--benchmarks`, `--all`, `--limit`, `5`, `--json` ]
    const control = async () => {
        control_calls++; return `Available` 
    }
    expect( await run_model( args, { control, benchmarks: async received => JSON.stringify( received ) } ) ).toBe( JSON.stringify( args ) )
    await expect( run_model( args, { control, benchmarks: async () => {
        throw new Error( `No key` ) 
    } } ) ).rejects.toThrow( `No key` )
    expect( control_calls ).toBe( 0 )
} )
