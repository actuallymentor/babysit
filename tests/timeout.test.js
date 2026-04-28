import { describe, it, expect } from 'bun:test'
import { parse_timeout, format_timeout } from '../src/babysit/timeout.js'

describe( `parse_timeout`, () => {

    it( `parses plain seconds`, () => {
        expect( parse_timeout( 30 ) ).toBe( 30 )
        expect( parse_timeout( `300` ) ).toBe( 300 )
    } )

    it( `parses MM:SS format`, () => {
        expect( parse_timeout( `05:00` ) ).toBe( 300 )
        expect( parse_timeout( `1:30` ) ).toBe( 90 )
        expect( parse_timeout( `30:00` ) ).toBe( 1800 )
    } )

    it( `parses HH:MM:SS format`, () => {
        expect( parse_timeout( `1:00:00` ) ).toBe( 3600 )
        expect( parse_timeout( `01:30:00` ) ).toBe( 5400 )
        expect( parse_timeout( `2:15:30` ) ).toBe( 8130 )
    } )

} )

describe( `format_timeout`, () => {

    it( `formats seconds as MM:SS`, () => {
        expect( format_timeout( 90 ) ).toBe( `01:30` )
        expect( format_timeout( 300 ) ).toBe( `05:00` )
    } )

    it( `formats hours as HH:MM:SS`, () => {
        expect( format_timeout( 3661 ) ).toBe( `01:01:01` )
    } )

    it( `formats zero`, () => {
        expect( format_timeout( 0 ) ).toBe( `00:00` )
    } )

} )
