import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { control_store } from '../src/docker/assets/effort/control-store.mjs'

const roots = []
afterEach( () => roots.splice( 0 ).forEach( root => rmSync( root, { recursive: true, force: true } ) ) )
const fixture = () => {
    const root = mkdtempSync( join( tmpdir(), `babysit-control-test-` ) )
    roots.push( root )
    const launch_id = randomUUID()
    const env = { BABYSIT_CONTROL_ID: launch_id, BABYSIT_CONTROL_TEST_ROOT: root }
    return { root, launch_id, request: input => control_store( { launch_id, ...input }, env ), file: id => join( root, `.babysit-control-${ launch_id }`, `${ id }.json` ) }
}

test( `queued changes preserve pending, claimed and applied results`, () => {
    const { request } = fixture()
    const id = randomUUID()
    expect( request( { action: `enqueue`, id, operation: `model`, value: `sonnet` } ).status ).toBe( `pending` )
    expect( request( { action: `take` } ).status ).toBe( `processing` )
    expect( request( { action: `take` } ) ).toBeNull()
    request( { action: `result`, id, status: `pending`, message: `Draft open` } )
    expect( request( { action: `take` } ).id ).toBe( id )
    request( { action: `result`, id, status: `applied`, message: `Sonnet selected for this session.` } )
    expect( request( { action: `status`, id } ).message ).toContain( `Sonnet` )
    expect( request( { action: `take` } ) ).toBeNull()
} )

test( `expired requests fail without being dispatched`, () => {
    const { request, file } = fixture()
    const id = randomUUID()
    request( { action: `enqueue`, id, operation: `effort`, value: `high` } )
    const record = JSON.parse( readFileSync( file( id ), `utf8` ) )
    writeFileSync( file( id ), JSON.stringify( { ...record, expires_at: Date.now() - 1 } ) )
    expect( request( { action: `take` } ) ).toBeNull()
    expect( request( { action: `status`, id } ).status ).toBe( `failed` )
} )

test( `stale launches, duplicate ids and terminal injection values are rejected`, () => {
    const { request } = fixture()
    expect( () => request( { action: `take`, launch_id: randomUUID() } ) ).toThrow( `stale` )
    expect( () => request( { action: `enqueue`, id: randomUUID(), operation: `model`, value: `sonnet\n/exit` } ) ).toThrow( `Invalid` )
    const input = { action: `enqueue`, id: randomUUID(), operation: `effort`, value: `low` }
    request( input )
    expect( () => request( input ) ).toThrow()
} )

test( `status does not follow a symlinked record`, () => {
    const { request, file, root } = fixture()
    const id = randomUUID()
    request( { action: `take` } )
    const elsewhere = join( root, `elsewhere` )
    writeFileSync( elsewhere, `{}` )
    symlinkSync( elsewhere, file( id ) )
    expect( () => request( { action: `status`, id } ) ).toThrow()
} )

test( `queued changes run in submission order, beyond retained result files`, () => {
    const { request, file } = fixture()
    const earlier = `ffffffff-ffff-ffff-ffff-ffffffffffff`
    const later = `00000000-0000-0000-0000-000000000000`
    for( const [ id, age ] of [ [ earlier, 2_000 ], [ later, 1_000 ] ] ) {
        const record = request( { action: `enqueue`, id, operation: `model`, value: `sonnet` } )
        writeFileSync( file( id ), JSON.stringify( { ...record, created_at: Date.now() - age } ) )
    }
    for( let index = 0; index < 1_005; index++ ) {
        const id = randomUUID()
        request( { action: `enqueue`, id, operation: `effort`, value: `low` } )
        request( { action: `result`, id, status: `applied`, message: `done` } )
    }
    expect( request( { action: `take` } ).id ).toBe( earlier )
    request( { action: `result`, id: earlier, status: `applied`, message: `done` } )
    expect( request( { action: `take` } ).id ).toBe( later )
} )

test( `late confirmation cannot replace an expired result`, () => {
    const { request, file } = fixture()
    const id = randomUUID()
    request( { action: `enqueue`, id, operation: `model`, value: `sonnet` } )
    const record = request( { action: `take` } )
    expect( record.remaining_ms ).toBeGreaterThan( 0 )
    writeFileSync( file( id ), JSON.stringify( { ...record, expires_at: Date.now() - 1 } ) )
    expect( request( { action: `status`, id } ).status ).toBe( `failed` )
    expect( request( { action: `result`, id, status: `applied`, message: `late` } ).status ).toBe( `failed` )
} )
