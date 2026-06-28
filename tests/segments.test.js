import { describe, it, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { load_markdown_segments, split_segments } from '../src/babysit/segments.js'

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

describe( `load_markdown_segments`, () => {

    it( `expands %initial_prompt% inside markdown segments`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-segments-` ) )
        const file = join( dir, `LOOP.md` )

        try {
            writeFileSync( file, `Before\n%initial_prompt%\nAfter\n===\n%initial_prompt%` )

            const segments = load_markdown_segments( file, {
                config: { initial_prompt: `Launch\nbrief` },
            } )

            expect( segments ).toEqual( [
                `Before\nLaunch\nbrief\nAfter`,
                `Launch\nbrief`,
            ] )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `preserves replacement-like text from initial_prompt literally`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-segments-` ) )
        const file = join( dir, `LOOP.md` )

        try {
            writeFileSync( file, `%initial_prompt%` )

            const segments = load_markdown_segments( file, {
                config: { initial_prompt: `Keep $& and $$ as written` },
            } )

            expect( segments ).toEqual( [ `Keep $& and $$ as written` ] )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `drops placeholder-only segments when initial_prompt is disabled`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-segments-` ) )
        const file = join( dir, `LOOP.md` )

        try {
            writeFileSync( file, `%initial_prompt%\n===\nStill continue` )

            const segments = load_markdown_segments( file, {
                config: { initial_prompt: null },
            } )

            expect( segments ).toEqual( [ `Still continue` ] )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

} )
