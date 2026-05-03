import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'fs'
import { join, isAbsolute } from 'path'
import { homedir, tmpdir } from 'os'

import {
    default_log_name,
    resolve_log_path,
    format_session_header,
    append_session_header,
} from '../src/utils/log_file.js'

describe( `default_log_name`, () => {

    it( `formats the timestamp as .YYYY_MM_DD_HH_MM.babysit.log`, () => {

        // 2026-05-03 14:07
        const now = new Date( 2026, 4, 3, 14, 7 )
        expect( default_log_name( now ) ).toBe( `.2026_05_03_14_07.babysit.log` )

    } )

    it( `zero-pads single-digit components`, () => {

        // Jan 1, 01:01
        const now = new Date( 2026, 0, 1, 1, 1 )
        expect( default_log_name( now ) ).toBe( `.2026_01_01_01_01.babysit.log` )

    } )

} )

describe( `resolve_log_path`, () => {

    it( `falls back to the default name when the flag value is empty`, () => {

        const cwd = `/some/dir`
        const now = new Date( 2026, 4, 3, 14, 7 )
        expect( resolve_log_path( ``, { cwd, now } ) ).toBe( `/some/dir/.2026_05_03_14_07.babysit.log` )

    } )

    it( `falls back to the default name when the flag value is true (legacy boolean form)`, () => {

        // Defensive: the parser hands us a string, but the doc shape allows true/null
        const now = new Date( 2026, 4, 3, 14, 7 )
        expect( resolve_log_path( true, { cwd: `/x`, now } ) ).toBe( `/x/.2026_05_03_14_07.babysit.log` )

    } )

    it( `expands a leading ~/`, () => {

        const path = resolve_log_path( `~/logs/babysit.log`, { cwd: `/anywhere` } )
        expect( path ).toBe( join( homedir(), `logs/babysit.log` ) )

    } )

    it( `resolves a relative path against cwd`, () => {

        expect( resolve_log_path( `babysit.log`, { cwd: `/proj` } ) ).toBe( `/proj/babysit.log` )
        expect( resolve_log_path( `./babysit.log`, { cwd: `/proj` } ) ).toBe( `/proj/babysit.log` )

    } )

    it( `returns absolute paths unchanged`, () => {

        const abs = `/var/log/babysit.log`
        expect( resolve_log_path( abs, { cwd: `/anywhere` } ) ).toBe( abs )

    } )

    it( `always produces an absolute path`, () => {

        // Important so the tmux pipe-pane command (which runs in a shell with
        // an arbitrary cwd) writes to the directory the user expected.
        expect( isAbsolute( resolve_log_path( `foo.log`, { cwd: `/proj` } ) ) ).toBe( true )
        expect( isAbsolute( resolve_log_path( ``, { cwd: `/proj` } ) ) ).toBe( true )
        expect( isAbsolute( resolve_log_path( `~/x.log` ) ) ).toBe( true )

    } )

} )

describe( `format_session_header`, () => {

    it( `formats as "Babysit session start: YYYY-MM-DD HH:MM:SS"`, () => {

        const now = new Date( 2026, 4, 3, 14, 7, 42 )
        expect( format_session_header( now ) ).toBe( `Babysit session start: 2026-05-03 14:07:42` )

    } )

    it( `zero-pads single-digit components`, () => {

        const now = new Date( 2026, 0, 1, 1, 1, 1 )
        expect( format_session_header( now ) ).toBe( `Babysit session start: 2026-01-01 01:01:01` )

    } )

} )

describe( `append_session_header`, () => {

    let dir
    let log_path

    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-logfile-` ) )
        log_path = join( dir, `babysit.log` )
    } )

    afterEach( () => {
        rmSync( dir, { recursive: true, force: true } )
    } )

    it( `creates the file on first call and writes the header`, () => {

        const now = new Date( 2026, 4, 3, 14, 7, 0 )
        expect( append_session_header( log_path, now ) ).toBe( true )
        expect( readFileSync( log_path, `utf-8` ) ).toBe( `Babysit session start: 2026-05-03 14:07:00\n` )

    } )

    it( `appends a leading blank line when the file already has content (separator between sessions)`, () => {

        writeFileSync( log_path, `prior session output...\n` )
        const now = new Date( 2026, 4, 3, 14, 7, 0 )
        append_session_header( log_path, now )
        expect( readFileSync( log_path, `utf-8` ) ).toBe(
            `prior session output...\n\nBabysit session start: 2026-05-03 14:07:00\n`
        )

    } )

    it( `creates missing parent directories`, () => {

        const nested = join( dir, `a`, `b`, `c`, `nested.log` )
        expect( append_session_header( nested ) ).toBe( true )
        expect( existsSync( nested ) ).toBe( true )

    } )

    it( `returns false when the path is unwritable instead of throwing`, () => {

        // A path with a NUL byte trips Node's filename validation cleanly.
        // We want callers to keep running (skip logging) on filesystem errors,
        // not crash the whole session start.
        const bad = join( dir, `bad\0name.log` )
        expect( append_session_header( bad ) ).toBe( false )

    } )

} )
