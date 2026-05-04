import { describe, it, expect } from 'bun:test'
import { EventEmitter } from 'events'

import { caffeinate_args, start_caffeinate, stop_caffeinate } from '../src/utils/caffeinate.js'

const fake_child = () => {

    const child = new EventEmitter()
    child.pid = 1234
    child.killed = false
    child.unref_called = false
    child.kill_called = false
    child.unref = () => {
        child.unref_called = true
    }
    child.kill = () => {
        child.kill_called = true
        child.killed = true
    }
    return child

}

describe( `caffeinate_args`, () => {

    it( `ties caffeinate to the monitor pid`, () => {
        expect( caffeinate_args( 42 ) ).toEqual( [ `-d`, `-i`, `-m`, `-s`, `-u`, `-w`, `42` ] )
    } )

} )

describe( `start_caffeinate`, () => {

    it( `is a no-op off macOS`, () => {

        let spawned = false
        const child = start_caffeinate( {
            platform: `linux`,
            spawn_fn: () => {
                spawned = true
            },
        } )

        expect( child ).toBeNull()
        expect( spawned ).toBe( false )

    } )

    it( `spawns caffeinate on macOS and unrefs it`, () => {

        const calls = []
        const child = fake_child()
        const result = start_caffeinate( {
            platform: `darwin`,
            pid: 99,
            spawn_fn: ( cmd, args, options ) => {
                calls.push( { cmd, args, options } )
                return child
            },
        } )

        expect( result ).toBe( child )
        expect( calls ).toEqual( [ {
            cmd: `caffeinate`,
            args: [ `-d`, `-i`, `-m`, `-s`, `-u`, `-w`, `99` ],
            options: { stdio: `ignore` },
        } ] )
        expect( child.unref_called ).toBe( true )

    } )

    it( `returns null when caffeinate cannot be spawned`, () => {

        const result = start_caffeinate( {
            platform: `darwin`,
            spawn_fn: () => {
                throw new Error( `missing` )
            },
        } )

        expect( result ).toBeNull()

    } )

} )

describe( `stop_caffeinate`, () => {

    it( `kills a running caffeinate child`, () => {

        const child = fake_child()
        stop_caffeinate( child )
        expect( child.kill_called ).toBe( true )

    } )

    it( `ignores null and already-killed children`, () => {

        stop_caffeinate( null )

        const child = fake_child()
        child.killed = true
        stop_caffeinate( child )
        expect( child.kill_called ).toBe( false )

    } )

} )
