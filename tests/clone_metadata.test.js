import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { prepare_clone_workspace } from '../src/clone.js'

// These suites exercise working-tree copies; the product default is git mode.
const COPY_EVERYTHING = { mode: `copy`, exclude: [] }

const run = ( command, args ) => {

    const result = spawnSync( command, args, { encoding: `utf8` } )
    if( result.error || result.status !== 0 ) throw new Error( result.error?.message || result.stderr )
    return result.stdout.trim()

}

describe.skipIf( process.platform !== `linux` )( `Linux clone metadata`, () => {

    let directory
    let source
    let clones_dir

    beforeEach( () => {
        directory = mkdtempSync( join( tmpdir(), `babysit-clone-metadata-` ) )
        source = join( directory, `source` )
        clones_dir = join( directory, `clones` )
        mkdirSync( source )
    } )

    afterEach( () => rmSync( directory, { recursive: true, force: true } ) )

    it( `preserves file metadata and cross-directory hard links without importing root attributes`, () => {

        // Python exposes nanosecond utime and xattrs without a native addon.
        run( `python3`, [ `-c`, `
import os, pathlib, sys
root = pathlib.Path(sys.argv[1])
(root / 'first').mkdir()
(root / 'second').mkdir()
(root / 'empty').mkdir()
file = root / 'first' / 'executable'
file.write_bytes(b'original payload')
file.chmod(0o751)
os.link(file, root / 'second' / 'hardlink')
os.symlink('../first/executable', root / 'second' / 'symlink')
(root / '-- leading space\\nline\\ttab').write_text('unusual name')
(root / '.hidden').write_text('hidden')
(root / '#notes#').write_text('autosave')
(root / ';notes').write_text('semicolon')
(root / 'node_modules').mkdir()
(root / 'node_modules' / 'dependency').write_text('dependency')
with (root / 'sparse').open('wb') as sparse:
    sparse.seek(16 * 1024 * 1024)
    sparse.write(b'end')
os.setxattr(file, b'user.babysit-test', b'binary\\x00value')
os.setxattr(root, b'user.babysit-root', b'not inherited')
os.utime(file, ns=(1700000000123456789, 1700000000987654321))
os.utime(root / 'empty', ns=(1700000000123456789, 1700000000765432109))
`, source ] )

        const result = prepare_clone_workspace( { clone_config: COPY_EVERYTHING, source, clones_dir, clone_id: `metadata` } )
        const metadata = path => JSON.parse( run( `python3`, [ `-c`, `
import json, os, sys
path = sys.argv[1]
stat = os.stat(path)
print(json.dumps({'mode': stat.st_mode & 0o7777, 'mtime_ns': stat.st_mtime_ns, 'xattrs': {key: os.getxattr(path, key).hex() for key in os.listxattr(path)}}))
`, path ] ) )
        const original = join( source, `first`, `executable` )
        const copied = join( result.workspace, `first`, `executable` )
        expect( metadata( copied ) ).toEqual( metadata( original ) )
        expect( run( `getfacl`, [ `-cp`, copied ] ) ).toBe( run( `getfacl`, [ `-cp`, original ] ) )
        expect( metadata( join( result.workspace, `empty` ) ) ).toEqual( metadata( join( source, `empty` ) ) )
        expect( statSync( copied ).ino ).toBe( statSync( join( result.workspace, `second`, `hardlink` ) ).ino )
        expect( statSync( copied ).ino ).not.toBe( statSync( original ).ino )
        expect( statSync( join( result.workspace, `sparse` ) ).size ).toBe( 16 * 1024 * 1024 + 3 )
        expect( statSync( join( result.workspace, `sparse` ) ).blocks * 512 ).toBeLessThan( 1024 * 1024 )
        expect( readlinkSync( join( result.workspace, `second`, `symlink` ) ) ).toBe( `../first/executable` )
        expect( readFileSync( join( result.workspace, `-- leading space\nline\ttab` ), `utf8` ) ).toBe( `unusual name` )
        expect( readFileSync( join( result.workspace, `.hidden` ), `utf8` ) ).toBe( `hidden` )
        expect( readFileSync( join( result.workspace, `#notes#` ), `utf8` ) ).toBe( `autosave` )
        expect( readFileSync( join( result.workspace, `;notes` ), `utf8` ) ).toBe( `semicolon` )
        expect( readFileSync( join( result.workspace, `node_modules`, `dependency` ), `utf8` ) ).toBe( `dependency` )
        expect( metadata( result.workspace ).mode ).toBe( 0o700 )
        expect( metadata( result.workspace ).xattrs ).toEqual( {} )
        expect( run( `getfacl`, [ `-cp`, result.workspace ] ) ).toBe( `user::rwx\ngroup::---\nother::---` )

        writeFileSync( copied, `clone edit` )
        expect( readFileSync( original, `utf8` ) ).toBe( `original payload` )
        expect( readFileSync( join( result.workspace, `second`, `hardlink` ), `utf8` ) ).toBe( `clone edit` )
        writeFileSync( original, `source edit` )
        expect( readFileSync( copied, `utf8` ) ).toBe( `clone edit` )

    } )

    it( `preserves ACLs on an ACL-capable filesystem without importing root ACLs`, () => {

        // Container overlay filesystems may reject ACLs; Linux tmpfs supports
        // them, so this remains a real preservation test rather than a skip.
        const acl_root = mkdtempSync( `/dev/shm/babysit-clone-acl-` )
        try {
            const acl_source = join( acl_root, `source` )
            mkdirSync( acl_source )
            writeFileSync( join( acl_source, `file` ), `ACL payload` )
            run( `setfacl`, [ `-m`, `u:65534:r--`, join( acl_source, `file` ) ] )
            run( `setfacl`, [ `-m`, `u:65534:r-x,d:u:65534:r-x`, acl_source ] )
            const clone = prepare_clone_workspace( { clone_config: COPY_EVERYTHING, source: acl_source, clones_dir: join( acl_root, `clones` ), clone_id: `acl` } )
            expect( run( `getfacl`, [ `-cp`, join( clone.workspace, `file` ) ] ) )
                .toBe( run( `getfacl`, [ `-cp`, join( acl_source, `file` ) ] ) )
            expect( run( `getfacl`, [ `-cp`, clone.workspace ] ) ).toBe( `user::rwx\ngroup::---\nother::---` )
            expect( statSync( clone.workspace ).mode & 0o777 ).toBe( 0o700 )
        } finally {
            rmSync( acl_root, { recursive: true, force: true } )
        }

    } )

    it.each( [ `missing`, `vanished`, `denied`, `signal`, `spawn` ] )( `cleans failed %s copies without publishing or falling back`, failure => {

        const bin = join( directory, `bin` )
        mkdirSync( bin )
        writeFileSync( join( source, `payload` ), `must not silently copy` )
        const fixture = {
            vanished: `#!/bin/sh\n/bin/cat >/dev/null\necho 'vanished source file' >&2\nexit 24\n`,
            denied: `#!/bin/sh\n/bin/cat >/dev/null\necho 'Permission denied' >&2\nexit 23\n`,
            signal: `#!/bin/sh\n/bin/cat >/dev/null\nkill -TERM $$\n`,
            spawn: `#!/bin/sh\nexit 0\n`,
        }[ failure ]
        if( fixture ) {
            writeFileSync( join( bin, `rsync` ), fixture )
            chmodSync( join( bin, `rsync` ), failure === `spawn` ? 0o600 : 0o700 )
        }
        const node = run( `node`, [ `-p`, `process.execPath` ] )
        const script = `
            import { prepare_clone_workspace } from ${ JSON.stringify( import.meta.resolve( `../src/clone.js` ) ) }
            try {
                prepare_clone_workspace(${ JSON.stringify( { source, clones_dir, clone_id: `failed` } ) })
                process.exitCode = 1
            } catch (error) {
                process.stdout.write(error.message)
            }
        `
        const result = spawnSync( node, [ `--input-type=module`, `-e`, script ], {
            encoding: `utf8`, env: { ...process.env, PATH: bin },
        } )
        expect( result.status ).toBe( 0 )
        expect( result.stdout ).toContain( failure === `missing` ? `sudo apt install rsync` : `Clone copy failed: rsync` )
        if( failure === `vanished` ) expect( result.stdout ).toContain( `exit 24` )
        if( failure === `signal` ) expect( result.stdout ).toContain( `SIGTERM` )
        if( failure === `denied` ) expect( result.stdout ).toContain( `Permission denied` )
        expect( existsSync( join( clones_dir, `failed` ) ) ).toBe( false )
        for( const state of [ `partials`, `locks`, `manifests` ] ) {
            expect( readdirSync( join( clones_dir, `.babysit-state`, state ) ) ).toEqual( [] )
        }
        expect( readFileSync( join( source, `payload` ), `utf8` ) ).toBe( `must not silently copy` )

    } )

    it( `reuses completed clones without rsync`, () => {

        const options = { clone_config: COPY_EVERYTHING, source, clones_dir, clone_id: `reuse` }
        const clone = prepare_clone_workspace( options )
        writeFileSync( join( clone.workspace, `keep` ), `existing edit` )
        const node = run( `node`, [ `-p`, `process.execPath` ] )
        const result = spawnSync( node, [ `--input-type=module`, `-e`, `
            import { prepare_clone_workspace } from ${ JSON.stringify( import.meta.resolve( `../src/clone.js` ) ) }
            process.stdout.write(JSON.stringify(prepare_clone_workspace(${ JSON.stringify( options ) })))
        ` ], { encoding: `utf8`, env: { ...process.env, PATH: `` } } )
        expect( result.status ).toBe( 0 )
        expect( JSON.parse( result.stdout ).reused ).toBe( true )
        expect( readFileSync( join( clone.workspace, `keep` ), `utf8` ) ).toBe( `existing edit` )

    } )

} )
