import { expect, test } from 'bun:test'
import { create_control_bridge } from '../src/control/bridge.js'

const session = { control_id: `11111111-1111-1111-1111-111111111111`, pane_id: `%7`, container_id: `a`.repeat( 64 ), agent: `claude` }
const settle = async bridge => {
    while( bridge.busy ) await new Promise( resolve => setTimeout( resolve, 1 ) )
}

test( `each queued request gets its own deadline and exact launch pane`, async () => {
    let time = 1_000
    let next
    const results = []
    const panes = []
    const bridge = create_control_bridge( session, {
        now: () => time,
        runner: async ( command, args ) => {
            expect( args ).toContain( session.container_id )
            expect( args ).toContain( `--user` )
            const input = JSON.parse( Buffer.from( args.at( -1 ), `base64` ) )
            expect( input.launch_id ).toBe( session.control_id )
            if( input.action === `result` ) results.push( input )
            const output = input.action === `take` ? next : input
            return Buffer.from( JSON.stringify( output ) ).toString( `base64` )
        },
        capture: async pane => { panes.push( pane ); return `ready` },
        execute: async ( { capture } ) => { await capture(); return { message: `selected` } },
    } )
    next = { id: `first`, operation: `effort`, value: `low`, remaining_ms: 60_000 }
    bridge.tick()
    await settle( bridge )
    time += 120_000
    next = { id: `second`, operation: `effort`, value: `high`, remaining_ms: 60_000 }
    bridge.tick()
    await settle( bridge )
    expect( results.map( result => result.status ) ).toEqual( [ `applied`, `applied` ] )
    expect( panes ).toEqual( [ `%7`, `%7` ] )
    await bridge.close()
} )

test( `drafts stay pending while a closed worker cannot type`, async () => {
    const results = []
    let calls = 0
    const bridge = create_control_bridge( session, {
        runner: async ( command, args ) => {
            const input = JSON.parse( Buffer.from( args.at( -1 ), `base64` ) )
            if( input.action === `result` ) results.push( input )
            return Buffer.from( JSON.stringify( input.action === `take` ? {
                id: `draft`, operation: `model`, value: `sonnet`, remaining_ms: 60_000,
            } : input ) ).toString( `base64` )
        },
        execute: async () => { calls++; throw Object.assign( new Error( `Draft open` ), { code: `CONTROL_PENDING` } ) },
    } )
    bridge.tick( { blocked: true } )
    expect( bridge.busy ).toBeFalse()
    bridge.tick()
    await settle( bridge )
    expect( results[0].status ).toBe( `pending` )
    await bridge.close()
    bridge.tick()
    expect( calls ).toBe( 1 )
} )

test( `slow empty polls leave time for monitor rules and web input`, async () => {
    let time = 1_000
    let calls = 0
    const bridge = create_control_bridge( session, {
        now: () => time,
        runner: async () => {
            calls++
            time += 3_000
            return Buffer.from( `null` ).toString( `base64` )
        },
    } )
    bridge.tick()
    await settle( bridge )
    bridge.tick()
    expect( bridge.busy ).toBeFalse()
    expect( calls ).toBe( 1 )
    time += 2_000
    bridge.tick()
    await settle( bridge )
    expect( calls ).toBe( 2 )
    await bridge.close()
} )

test( `expired controls can dismiss their owned dialog but cannot keep typing`, async () => {
    let time = 0
    const sent = []
    const bridge = create_control_bridge( session, {
        now: () => time,
        runner: async ( command, args ) => {
            const input = JSON.parse( Buffer.from( args.at( -1 ), `base64` ) )
            return Buffer.from( JSON.stringify( input.action === `take` ? {
                id: `expiry`, operation: `model`, value: `sonnet`, remaining_ms: 2_000,
            } : input ) ).toString( `base64` )
        },
        capture: async () => `Select model`,
        keys: async ( pane, key ) => sent.push( key ),
        execute: async ( { send_keys, dismiss } ) => {
            time = 3_000
            await expect( send_keys( `Enter` ) ).rejects.toThrow( `timed out` )
            await dismiss( screen => screen === `Select model` )
            throw new Error( `timed out` )
        },
    } )
    bridge.tick()
    await settle( bridge )
    expect( sent ).toEqual( [ `Escape` ] )
    await bridge.close()
} )
