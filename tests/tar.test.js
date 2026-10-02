import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, symlinkSync } from 'fs'
import { execFileSync as exec_file } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'

import { build_tar_archive } from '../src/docker/tar.js'

const read_header = ( archive, offset ) => ( {
    name: archive.toString( `utf8`, offset, offset + 100 ).replace( /\0.*$/s, `` ),
    mode: parseInt( archive.toString( `utf8`, offset + 100, offset + 107 ), 8 ),
    uid: parseInt( archive.toString( `utf8`, offset + 108, offset + 115 ), 8 ),
    size: parseInt( archive.toString( `utf8`, offset + 124, offset + 135 ), 8 ),
    type: archive.toString( `utf8`, offset + 156, offset + 157 ),
    magic: archive.toString( `utf8`, offset + 257, offset + 262 ),
    prefix: archive.toString( `utf8`, offset + 345, offset + 500 ).replace( /\0.*$/s, `` ),
} )

describe( `tar archive builder`, () => {

    const fixture = () => {
        const dir = mkdtempSync( join( tmpdir(), `babysit-tar-` ) )
        writeFileSync( join( dir, `creds.json` ), `{"token":"x"}` )
        chmodSync( join( dir, `creds.json` ), 0o600 )
        mkdirSync( join( dir, `gh` ) )
        writeFileSync( join( dir, `gh`, `hosts.yml` ), `github.com:\n` )
        return dir
    }

    it( `places files at absolute container paths as root with preserved modes`, () => {

        const dir = fixture()
        try {
            const archive = build_tar_archive( [
                { source: join( dir, `creds.json` ), target: `/home/node/.claude/.credentials.json` },
            ] )

            const header = read_header( archive, 0 )
            expect( header.name ).toBe( `home/node/.claude/.credentials.json` )
            expect( header.mode ).toBe( 0o600 )
            expect( header.uid ).toBe( 0 )
            expect( header.size ).toBe( 13 )
            expect( header.type ).toBe( `0` )
            expect( header.magic ).toBe( `ustar` )
            expect( archive.toString( `utf8`, 512, 525 ) ).toBe( `{"token":"x"}` )
            // header + one content block + two end-of-archive blocks
            expect( archive.length ).toBe( 512 * 4 )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `copies directory contents for docker's trailing "/." convention`, () => {

        const dir = fixture()
        try {
            const archive = build_tar_archive( [
                { source: `${ join( dir, `gh` ) }/.`, target: `/tmp/.babysit-gh` },
            ] )

            expect( read_header( archive, 0 ).name ).toBe( `tmp/.babysit-gh/hosts.yml` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `splits long paths into ustar prefix and name`, () => {

        const dir = fixture()
        try {
            const deep = `/${ `a`.repeat( 90 ) }/${ `b`.repeat( 85 ) }`
            const archive = build_tar_archive( [
                { source: join( dir, `creds.json` ), target: `${ deep }/creds.json` },
            ] )
            const header = read_header( archive, 0 )

            expect( header.prefix ).toBe( `a`.repeat( 90 ) )
            expect( header.name ).toBe( `${ `b`.repeat( 85 ) }/creds.json` )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `refuses symlinks instead of archiving their targets`, () => {

        const dir = fixture()
        try {
            symlinkSync( `/etc/hostname`, join( dir, `planted` ) )
            symlinkSync( `/etc`, join( dir, `gh`, `planted-dir` ) )

            expect( () => build_tar_archive( [ { source: join( dir, `planted` ), target: `/x/creds.json` } ] ) )
                .toThrow( /Refusing to upload symlink/ )
            expect( () => build_tar_archive( [ { source: `${ join( dir, `gh` ) }/.`, target: `/x` } ] ) )
                .toThrow( /Refusing to upload symlink/ )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `rejects a FIFO without blocking on it`, () => {

        const dir = fixture()
        try {
            exec_file( `mkfifo`, [ join( dir, `pipe` ) ] )

            expect( () => build_tar_archive( [ { source: join( dir, `pipe` ), target: `/x/creds.json` } ] ) )
                .toThrow( /Unsupported tar source/ )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `produces an archive system tar can extract`, () => {

        const dir = fixture()
        const out = mkdtempSync( join( tmpdir(), `babysit-tar-out-` ) )
        try {
            const archive = build_tar_archive( [
                { source: join( dir, `creds.json` ), target: `/x/y/creds.json` },
                { source: join( dir, `gh` ), target: `/x/gh` },
            ] )
            execFileSync( `tar`, [ `-xf`, `-`, `-C`, out ], { input: archive } )

            expect( execFileSync( `find`, [ out, `-type`, `f` ], { encoding: `utf8` } ).trim().split( `\n` ).sort() )
                .toEqual( [ join( out, `x/gh/hosts.yml` ), join( out, `x/y/creds.json` ) ] )
        } finally {
            rmSync( dir, { recursive: true, force: true } )
            rmSync( out, { recursive: true, force: true } )
        }

    } )

} )
