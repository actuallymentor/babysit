import { describe, it, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readlinkSync, lstatSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { link_short_name } from '../src/cli/update.js'

const scratch = () => mkdtempSync( join( tmpdir(), `babysit-sit-` ) )

describe( `link_short_name`, () => {

    it( `links sit to the installed binary, and again after an update`, () => {
        const dir = scratch()
        const target = join( dir, `babysit` )
        writeFileSync( target, `binary` )
        link_short_name( target )
        link_short_name( target )
        expect( readlinkSync( join( dir, `sit` ) ) ).toBe( `babysit` )
        expect( readFileSync( join( dir, `sit` ), `utf8` ) ).toBe( `binary` )
        rmSync( dir, { recursive: true } )
    } )

    it( `leaves a different program called sit alone`, () => {
        const dir = scratch()
        writeFileSync( join( dir, `sit` ), `someone else's` )
        link_short_name( join( dir, `babysit` ) )
        expect( lstatSync( join( dir, `sit` ) ).isSymbolicLink() ).toBe( false )
        expect( readFileSync( join( dir, `sit` ), `utf8` ) ).toBe( `someone else's` )
        rmSync( dir, { recursive: true } )
    } )

} )

describe( `install.sh short name`, () => {

    // Runs only the link step of the installer against a scratch directory
    const link_step = dir => {
        const script = readFileSync( join( import.meta.dir, `..`, `scripts`, `install.sh` ), `utf8` )
        const step = script.match( /# `sit` is the short name[\s\S]*?\nfi\n/ )[0]
        return spawnSync( `sh`, [ `-c`, `INSTALL_DIR='${ dir }'\n${ step }` ], { encoding: `utf8` } )
    }

    it( `links sit next to babysit and keeps a foreign sit`, () => {
        const dir = scratch()
        writeFileSync( join( dir, `babysit` ), `binary` )
        expect( link_step( dir ).status ).toBe( 0 )
        expect( readlinkSync( join( dir, `sit` ) ) ).toBe( `babysit` )
        rmSync( join( dir, `sit` ) )
        writeFileSync( join( dir, `sit` ), `foreign` )
        link_step( dir )
        expect( existsSync( join( dir, `sit` ) ) && readFileSync( join( dir, `sit` ), `utf8` ) ).toBe( `foreign` )
        rmSync( dir, { recursive: true } )
    } )

} )
