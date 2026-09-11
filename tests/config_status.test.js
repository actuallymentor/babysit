import { describe, expect, it } from 'bun:test'
import { read_recovery_status } from '../src/cli/config_status.js'

const unit = `babysit-recover-1000.service`
const unit_path = `/etc/systemd/system/${ unit }`
const settings = { platform: `linux`, uid: 1000 }

describe( `recovery configuration status`, () => {

    it( `reports enabled and inactive independently with one bounded read-only probe`, async () => {
        const calls = []
        const status = await read_recovery_status( {
            ...settings,
            exists: () => true,
            execute: async ( ...args ) => {
                calls.push( args )
                return `LoadState=loaded\nUnitFileState=enabled\nActiveState=inactive\n`
            },
        } )
        expect( status ).toEqual( { unit, installed: true, enabled: `enabled`, active: `inactive` } )
        expect( calls ).toEqual( [ [ `/usr/bin/systemctl`, [
            `show`, unit, `--all`, `--property=LoadState,UnitFileState,ActiveState`, `--no-pager`,
        ], {}, 3000 ] ] )
    } )

    it( `reports an authoritative missing unit separately from unavailable status`, async () => {
        const status = await read_recovery_status( {
            ...settings,
            exists: path => path === `/run/systemd/system`,
            execute: async () => `LoadState=not-found\nUnitFileState=\nActiveState=inactive`,
        } )
        expect( status ).toEqual( { unit, installed: false, enabled: `not installed`, active: `inactive` } )
    } )

    it( `retains unit-file evidence when systemd is not running`, async () => {
        let calls = 0
        for( const present of [ true, false ] ) {
            const status = await read_recovery_status( {
                ...settings,
                exists: path => present && path === unit_path,
                execute: async () => {
                    calls++
                    return ``
                },
            } )
            expect( status ).toEqual( { unit, installed: present ? true : null, enabled: `unknown`, active: `unknown` } )
        }
        expect( calls ).toBe( 0 )
    } )

    it( `never mistakes probe errors for an uninstalled service`, async () => {
        for( const present of [ true, false ] ) {
            const status = await read_recovery_status( {
                ...settings,
                exists: path => path === `/run/systemd/system` || present && path === unit_path,
                execute: async () => {
                    throw new Error( `System bus unavailable` )
                },
            } )
            expect( status ).toEqual( { unit, installed: present ? true : null, enabled: `unknown`, active: `unknown` } )
        }
    } )

    it( `does not probe unsupported platforms`, async () => {
        let calls = 0
        const status = await read_recovery_status( {
            ...settings, platform: `darwin`,
            exists: () => {
                calls++
                return true
            },
            execute: async () => {
                calls++
                    return ``
            },
        } )
        expect( status ).toEqual( { unit, installed: null, enabled: `not supported`, active: `not supported` } )
        expect( calls ).toBe( 0 )
    } )

} )
