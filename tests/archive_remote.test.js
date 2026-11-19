import { describe, it, expect, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { PRUNE_AFTER_MS, SENTINEL, SHIP_INTERVAL_MS, copy_tree, init_remote_archive, read_ship_status, remote_problem, ship_archive } from '../src/sessions/archive_remote.js'
import { normalise_transcript_remote } from '../src/babysit/config.js'
import { format_remote_archive } from '../src/cli/config.js'

// A second filesystem stands in for the share; tmpfs differs from the tmp disk here
const SHARE_PARENT = `/dev/shm`
const has_second_fs = existsSync( SHARE_PARENT ) && statSync( SHARE_PARENT ).dev !== statSync( tmpdir() ).dev

const made = []
const temp = ( parent = tmpdir() ) => {
    const path = mkdtempSync( join( parent, `babysit-remote-` ) )
    made.push( path )
    return path
}
afterEach( () => made.splice( 0 ).forEach( path => rmSync( path, { recursive: true, force: true } ) ) )

const write = ( root, path, text = `x` ) => {
    mkdirSync( join( root, path, `..` ), { recursive: true } )
    writeFileSync( join( root, path ), text )
}

describe( `remote archive binding`, () => {

    it( `never creates the remote root`, () => {
        const hot = temp()
        const missing = join( tmpdir(), `babysit-remote-missing-${ process.pid }` )
        expect( () => init_remote_archive( missing, { hot } ) ).toThrow( /Mount the share first/ )
        expect( existsSync( missing ) ).toBe( false )
    } )

    it( `refuses a directory on the local archive's disk (an unmounted share)`, () => {
        const hot = temp()
        const unmounted = temp()
        expect( () => init_remote_archive( unmounted, { hot } ) ).toThrow( /local disk/ )
        expect( existsSync( join( unmounted, SENTINEL ) ) ).toBe( false )
    } )

    // The bare mountpoint lives on / while the local archive has its own disk
    it.skipIf( !has_second_fs || statSync( tmpdir() ).dev !== statSync( `/` ).dev )( `refuses a bare mountpoint on the root disk`, () => {
        const hot = temp( SHARE_PARENT )
        const unmounted = temp()
        expect( () => init_remote_archive( unmounted, { hot } ) ).toThrow( /local disk/ )
    } )

    it( `adopts an existing identity, even from another host`, () => {
        const hot = temp()
        const share = temp()
        writeFileSync( join( share, SENTINEL ), JSON.stringify( { babysit_archive: 1, id: `abc` } ) )
        expect( init_remote_archive( share, { hot } ) ).toEqual( { path: share, id: `abc`, adopted: true } )
    } )

    it.skipIf( !has_second_fs )( `writes a fresh identity on a mounted filesystem`, () => {
        const hot = temp()
        const share = temp( SHARE_PARENT )
        const { id, adopted } = init_remote_archive( share, { hot } )
        expect( adopted ).toBe( false )
        expect( JSON.parse( readFileSync( join( share, SENTINEL ), `utf8` ) ) ).toMatchObject( { babysit_archive: 1, id } )
    } )

    it( `keeps only a complete binding in config`, () => {
        expect( normalise_transcript_remote( { path: `/mnt/nas`, id: `abc` } ) ).toEqual( { path: `/mnt/nas`, id: `abc` } )
        expect( normalise_transcript_remote( { path: `/mnt/nas` } ) ).toBe( false )
        expect( normalise_transcript_remote( { path: `nas`, id: `abc` } ) ).toBe( false )
        expect( normalise_transcript_remote( `/mnt/nas` ) ).toBe( false )
    } )

} )

describe( `remote checks`, () => {

    it( `reports a missing, foreign or local identity`, async () => {
        const hot = temp()
        const share = temp()
        expect( await remote_problem( { path: share, id: `abc` }, hot ) ).toMatch( /missing/ )
        writeFileSync( join( share, SENTINEL ), JSON.stringify( { babysit_archive: 1, id: `other` } ) )
        expect( await remote_problem( { path: share, id: `abc` }, hot ) ).toMatch( /another archive/ )
        writeFileSync( join( share, SENTINEL ), JSON.stringify( { babysit_archive: 1, id: `abc` } ) )
        expect( await remote_problem( { path: share, id: `abc` }, hot ) ).toMatch( /local disk/ )
    } )

} )

describe.skipIf( !has_second_fs )( `shipping`, () => {

    const setup = () => {
        const hot = temp()
        const share = temp( SHARE_PARENT )
        const { id } = init_remote_archive( share, { hot } )
        return { hot, share, remote: { path: share, id } }
    }

    it( `copies the hot archive under the host name, skipping temp files, and records it`, async () => {
        const { hot, share, remote } = setup()
        write( hot, `volumes/v1/session.jsonl`, `turn` )
        write( hot, `volumes/v1/.session.jsonl.x.babysit-partial` )
        write( hot, `sessions/b1.json`, `{}` )
        const status = await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        expect( status ).toMatchObject( { copied: 2, error: null, shipped_at: 1e12 } )
        expect( readFileSync( join( share, `box/volumes/v1/session.jsonl`), `utf8` ) ).toBe( `turn` )
        expect( existsSync( join( share, `box/volumes/v1/.session.jsonl.x.babysit-partial` ) ) ).toBe( false )
        expect( existsSync( join( share, `box/.ship.json` ) ) ).toBe( false )
        expect( read_ship_status( hot ) ).toMatchObject( { shipped_at: 1e12 } )
    } )

    it( `ships only what changed, at most every interval`, async () => {
        const { hot, remote } = setup()
        write( hot, `volumes/v1/a.jsonl` )
        await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        write( hot, `volumes/v1/b.jsonl` )
        expect( await ship_archive( { hot, remote, host: `box`, now: 1e12 + 1000 } ) ).toBe( null )
        expect( await ship_archive( { hot, remote, host: `box`, now: 1e12 + SHIP_INTERVAL_MS } ) ).toMatchObject( { copied: 1 } )
    } )

    it( `writes nothing when the share is gone, and says so`, async () => {
        const { hot, share, remote } = setup()
        write( hot, `volumes/v1/a.jsonl` )
        rmSync( join( share, SENTINEL ) )
        const status = await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        expect( status.error ).toMatch( /missing/ )
        expect( existsSync( join( share, `box` ) ) ).toBe( false )
        expect( format_remote_archive( { transcript_archive: hot, transcript_remote: remote }, 1e12 ) ).toMatch( /never shipped; failing/ )
    } )

    it( `prunes long-gone sandboxes only once they are on the share`, async () => {
        const { hot, share, remote } = setup()
        write( hot, `sandbox/old/state/a.jsonl` )
        write( hot, `sessions/old.json`, `{}` )
        write( hot, `sandbox/new/state/a.jsonl` )
        write( hot, `sessions/new.json`, `{}` )
        const now = Date.now() + PRUNE_AFTER_MS + 1000
        utimesSync( join( hot, `sessions/new.json` ), now / 1000, now / 1000 )

        // Present on the share but different: not verified, kept
        write( share, `box/sandbox/old/state/a.jsonl`, `changed` )
        rmSync( join( hot, `sandbox/old/state/a.jsonl` ) )
        write( hot, `sandbox/old/state/a.jsonl`, `y` )

        const status = await ship_archive( { hot, remote, host: `box`, now } )
        expect( status.pruned ).toBe( 1 )
        expect( existsSync( join( hot, `sandbox/old` ) ) ).toBe( false )
        expect( readFileSync( join( share, `box/sandbox/old/state/a.jsonl` ), `utf8` ) ).toBe( `y` )
        expect( existsSync( join( hot, `sandbox/new` ) ) ).toBe( true )
    } )

    it( `ships only archive trees, never credentials or stray files`, async () => {
        const { hot, share, remote } = setup()
        write( hot, `sandbox/b1/state/auth.json`, `secret` )
        write( hot, `sandbox/b1/state/log.jsonl` )
        write( hot, `unrelated/backup.tar` )
        await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        expect( existsSync( join( share, `box/sandbox/b1/state/log.jsonl` ) ) ).toBe( true )
        expect( existsSync( join( share, `box/sandbox/b1/state/auth.json` ) ) ).toBe( false )
        expect( existsSync( join( share, `box/unrelated` ) ) ).toBe( false )
    } )

    it( `keeps a sandbox whose bytes differ on the share despite matching size and mtime`, async () => {
        const { hot, share, remote } = setup()
        write( hot, `sandbox/old/a.jsonl`, `aaaa` )
        write( hot, `sessions/old.json`, `{}` )
        await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        const shipped = join( share, `box/sandbox/old/a.jsonl` )
        const { mtime } = statSync( shipped )
        writeFileSync( shipped, `bbbb` )
        utimesSync( shipped, mtime, mtime )
        const status = await ship_archive( { hot, remote, host: `box`, now: Date.now() + PRUNE_AFTER_MS + 1000 } )
        expect( status.pruned ).toBe( 0 )
        expect( existsSync( join( hot, `sandbox/old/a.jsonl` ) ) ).toBe( true )
    } )

    it( `forgets the status of a previous share on rebinding`, async () => {
        const { hot, remote } = setup()
        await ship_archive( { hot, remote, host: `box`, now: 1e12 } )
        expect( read_ship_status( hot, remote.id ) ).toMatchObject( { shipped_at: 1e12 } )
        expect( read_ship_status( hot, `other` ) ).toBe( null )
    } )

    it( `stops when the share leaves mid-ship instead of recreating it locally`, async () => {
        const hot = temp()
        const local = temp()
        write( hot, `a.jsonl` )
        const gone = { root: join( local, `box` ), dev: -1 }
        await expect( copy_tree( hot, join( local, `box/volumes` ), gone ) ).rejects.toThrow( /left mid-ship/ )
        expect( existsSync( join( local, `box` ) ) ).toBe( false )
    } )

    it( `lets one monitor ship at a time`, async () => {
        const { hot, remote } = setup()
        writeFileSync( join( hot, `.ship.lock` ), `1` )
        expect( await ship_archive( { hot, remote, host: `box`, now: 1e12 } ) ).toBe( null )
    } )

} )
