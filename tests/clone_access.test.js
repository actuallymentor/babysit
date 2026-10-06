import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { grant_clone_source_access, prepare_clone_workspace } from '../src/clone.js'
import { format_clone_access_report, prepare_clone_with_access_fix } from '../src/cli/start.js'

// These suites exercise working-tree copies; the product default is git mode.
const COPY_EVERYTHING = { mode: `copy`, exclude: [] }

// Root bypasses these permission checks, so the scenario only exists for normal users.
const as_root = process.getuid?.() === 0

describe.skipIf( as_root )( `clone of a source the user cannot fully read`, () => {

    let directory
    let source
    let clones_dir
    let pycache

    // Reproduces a real failure: Python under umask 0177 leaves `drw-------`
    // __pycache__ directories; the names list, but nothing inside can be stat'ed.
    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-access-` ) )
        source = join( directory, `source` )
        clones_dir = join( directory, `clones` )
        pycache = join( source, `artifacts`, `run-1`, `__pycache__` )
        mkdirSync( pycache, { recursive: true } )
        writeFileSync( join( source, `README.md` ), `hello\n` )
        writeFileSync( join( pycache, `billing.cpython-311.pyc` ), `bytecode` )
        chmodSync( join( pycache, `billing.cpython-311.pyc` ), 0o600 )
        chmodSync( pycache, 0o600 )
    } )

    afterEach( () => {
        chmodSync( pycache, 0o700 )
        rmSync( directory, { recursive: true, force: true } )
    } )

    it( `reports every unreadable path before copying anything`, () => {
        const secret = join( source, `write-only.txt` )
        writeFileSync( secret, `x` )
        chmodSync( secret, 0o200 )

        let error
        try {
            prepare_clone_workspace( { clone_config: COPY_EVERYTHING, source, clone_id: `blocked`, clones_dir } )
        } catch ( caught ) {
            error = caught
        }

        expect( error.code ).toBe( `CLONE_SOURCE_UNREADABLE` )
        expect( error.fixable ).toBe( true )
        expect( error.entries.map( ( { path, bits, directory: is_dir } ) => ( { path, bits, is_dir } ) ).sort( ( a, b ) => a.path.localeCompare( b.path ) ) ).toEqual( [
            { path: pycache, bits: `x`, is_dir: true },
            { path: secret, bits: `r`, is_dir: false },
        ] )
        expect( existsSync( join( clones_dir, `blocked` ) ) ).toBe( false )
        expect( readdirSync( join( clones_dir, `.babysit-state`, `partials` ) ) ).toEqual( [] )
    } )

    it( `shows the exact chmod for the owner`, () => {
        let error
        try {
            prepare_clone_workspace( { clone_config: COPY_EVERYTHING, source, clone_id: `report`, clones_dir } )
        } catch ( caught ) {
            error = caught
        }
        const { report, command } = format_clone_access_report( error )
        expect( command ).toBe( `chmod u+x ${ pycache }` )
        expect( report ).toContain( `drw-------  artifacts/run-1/__pycache__  — directory cannot be entered (no owner x)` )
        expect( report ).toContain( `Fix:\n  chmod u+x ${ pycache }` )
    } )

    it( `runs the chmod after the user agrees and retries the clone`, async () => {
        const questions = []
        const result = await prepare_clone_with_access_fix( { source, clone_id: `fixed`, clones_dir }, {
            confirm: async question => {
                questions.push( question ); return true
            },
        } )

        expect( questions ).toEqual( [ `Run this chmod now and retry the clone? [Y/n] ` ] )
        expect( statSync( pycache ).mode & 0o777 ).toBe( 0o700 )
        const copied = join( result.clone_path, `artifacts`, `run-1`, `__pycache__`, `billing.cpython-311.pyc` )
        expect( readFileSync( copied, `utf8` ) ).toBe( `bytecode` )
    } )

    it( `applies the fix without asking under --yes`, async () => {
        const result = await prepare_clone_with_access_fix( { source, clone_id: `yes`, clones_dir }, {
            assume_yes: true,
            confirm: async () => {
                throw new Error( `should not ask` )
            },
        } )
        expect( existsSync( join( result.clone_path, `README.md` ) ) ).toBe( true )
    } )

    it( `changes nothing when the user declines`, async () => {
        await expect( prepare_clone_with_access_fix( { source, clone_id: `declined`, clones_dir }, {
            confirm: async () => false,
        } ) ).rejects.toThrow( `Clone aborted; run the chmod above and retry.` )
        expect( statSync( pycache ).mode & 0o777 ).toBe( 0o600 )
        expect( existsSync( join( clones_dir, `declined` ) ) ).toBe( false )
    } )

    it( `refuses to chmod a path swapped after the audit`, () => {
        let error
        try {
            prepare_clone_workspace( { clone_config: COPY_EVERYTHING, source, clone_id: `swap`, clones_dir } )
        } catch ( caught ) {
            error = caught
        }
        chmodSync( pycache, 0o700 )
        renameSync( pycache, `${ pycache }.old` )
        mkdirSync( pycache, { mode: 0o600 } )
        expect( () => grant_clone_source_access( error.entries ) ).toThrow( `changed since it was checked` )
        expect( statSync( pycache ).mode & 0o777 ).toBe( 0o600 )
    } )

} )

describe( `clone access fix boundaries`, () => {

    it( `does not offer to fix paths owned by another user`, async () => {
        const error = Object.assign( new Error( `blocked` ), {
            code: `CLONE_SOURCE_UNREADABLE`,
            source: `/src`,
            fixable: false,
            entries: [ { path: `/src/root-only`, directory: true, mode: 0o700, uid: 0, bits: `` } ],
        } )
        const { report, command } = format_clone_access_report( error )
        expect( command ).toBeNull()
        expect( report ).toContain( `owned by uid 0; fix as that user or with sudo` )
        await expect( prepare_clone_with_access_fix( {}, {
            prepare: () => {
                throw error
            },
            confirm: async () => {
                throw new Error( `should not ask` )
            },
        } ) ).rejects.toThrow( `Clone aborted; fix the permissions above and retry.` )
    } )

    it( `stops when chmod does not take effect`, async () => {
        const entry = { path: `/src/stuck`, directory: true, mode: 0o600, uid: 1000, bits: `x`, dev: 1, ino: 1 }
        let attempts = 0
        await expect( prepare_clone_with_access_fix( {}, {
            assume_yes: true,
            prepare: () => {
                attempts++
                throw Object.assign( new Error( `blocked` ), { code: `CLONE_SOURCE_UNREADABLE`, source: `/src`, fixable: true, entries: [ entry ] } )
            },
            grant: () => 1,
        } ) ).rejects.toThrow( `Clone aborted; fix the permissions above and retry.` )
        expect( attempts ).toBe( 2 )
    } )

    it( `gives up after a bounded number of fix rounds`, async () => {
        let attempts = 0
        await expect( prepare_clone_with_access_fix( {}, {
            assume_yes: true,
            prepare: () => {
                attempts++
                const entry = { path: `/src/level-${ attempts }`, directory: true, mode: 0o600, uid: 1000, bits: `x` }
                throw Object.assign( new Error( `blocked` ), { code: `CLONE_SOURCE_UNREADABLE`, source: `/src`, fixable: true, entries: [ entry ] } )
            },
            grant: entries => entries.length,
        } ) ).rejects.toThrow( `Clone aborted after 10 permission fixes` )
        expect( attempts ).toBe( 11 )
    } )

    it( `switches to a find command for large trees`, () => {
        const entries = Array.from( { length: 25 }, ( _, index ) => ( { path: `/src/d${ index }`, directory: true, mode: 0o600, uid: 1000, bits: `x` } ) )
        const { report, command } = format_clone_access_report( { source: `/src`, entries } )
        expect( command ).toContain( `find /src -user "$(id -u)" -type d ! -perm -u+rx -exec chmod u+rx {} +` )
        expect( report ).toContain( `…and 5 more` )
    } )

} )
