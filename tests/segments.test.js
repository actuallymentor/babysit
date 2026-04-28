import { describe, it, expect } from 'bun:test'
import { split_segments } from '../src/babysit/segments.js'

describe( `split_segments`, () => {

    it( `splits on === lines`, () => {
        const input = `first segment\n===\nsecond segment\n===\nthird`
        const result = split_segments( input )
        expect( result ).toEqual( [ `first segment`, `second segment`, `third` ] )
    } )

    it( `handles multiple = signs`, () => {
        const input = `one\n=====\ntwo`
        expect( split_segments( input ) ).toEqual( [ `one`, `two` ] )
    } )

    it( `filters empty segments`, () => {
        const input = `one\n===\n\n===\nthree`
        expect( split_segments( input ) ).toEqual( [ `one`, `three` ] )
    } )

    it( `handles single segment`, () => {
        expect( split_segments( `just one thing` ) ).toEqual( [ `just one thing` ] )
    } )

    it( `trims whitespace`, () => {
        const input = `  first  \n===\n  second  `
        expect( split_segments( input ) ).toEqual( [ `first`, `second` ] )
    } )

} )
