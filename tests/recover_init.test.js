import { describe, expect, it } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { install_recovery_service, render_recovery_service } from '../src/cli/recover_init.js'

const settings = { uid: 1000, gid: 1000, home: `/home/alice`, command: [ `/usr/bin/true` ], path: `/usr/bin:/bin` }

describe( `boot recovery service`, () => {
    it( `retains detached children and stops recovery before Docker during shutdown`, () => {
        const unit = render_recovery_service( settings )
        expect( unit ).toContain( `After=network-online.target docker.service` )
        expect( unit ).toContain( `Type=exec` )
        expect( unit ).toContain( `RemainAfterExit=yes` )
        expect( unit ).toContain( `TimeoutStartSec=30\n` )
        expect( unit ).toContain( `ExecStart="/usr/bin/true" recover --boot` )
        expect( unit ).toContain( `ExecStop="/usr/bin/true" recover --shutdown` )
        expect( unit ).toContain( `TimeoutStopSec=120` )
        expect( unit ).toContain( `KillMode=control-group` )
        expect( unit ).toContain( `User=1000\nGroup=1000` )
    } )

    it( `escapes systemd expansion and rejects injected directives`, () => {
        const unit = render_recovery_service( { ...settings, command: [ `/opt/100%/$user/"babysit"` ], home: `/home/100%`, workspaces: [ `/mnt/work space` ] } )
        expect( unit ).toContain( `ExecStart="/opt/100%%/$user/\\"babysit\\""` )
        expect( unit ).toContain( `"/mnt/work space"` )
        expect( unit ).toContain( `Environment="HOME=/home/100%%"` )
        expect( () => render_recovery_service( { ...settings, path: `/bin\nExecStart=/evil` } ) ).toThrow( `control characters` )
        expect( () => render_recovery_service( { ...settings, command: [ `babysit` ] } ) ).toThrow( `absolute` )
        expect( () => render_recovery_service( { ...settings, uid: NaN } ) ).toThrow( `account` )
    } )

    it.skipIf( !existsSync( `/usr/bin/systemd-analyze` ) )( `passes the real systemd unit verifier`, () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-unit-check-` ) )
        try {
            const file = join( directory, `babysit-recover-1000.service` )
            const executable = join( directory, `babysit 100% $literal` )
            copyFileSync( `/usr/bin/true`, executable )
            writeFileSync( file, render_recovery_service( { ...settings, command: [ executable ], home: `/home/space user`, workspaces: [ `/mnt/space work` ] } ) )
            const result = spawnSync( `/usr/bin/systemd-analyze`, [ `verify`, file ], { encoding: `utf8`, timeout: 10_000 } )
            expect( result.stderr ).toBe( `` )
            expect( result.status ).toBe( 0 )
        } finally {
            rmSync( directory, { recursive: true, force: true } )
        }
    }, 15_000 )

    it( `installs private staged content and enables without starting or restarting`, async () => {
        const calls = []
        let staged
        const unit = render_recovery_service( settings )
        const execute = async ( command, args ) => {
            calls.push( [ command, ...args ] )
            if( command === `install` ) {
                staged = args.at( -2 )
                expect( readFileSync( staged, `utf8` ) ).toBe( unit )
            }
        }
        const result = await install_recovery_service( { unit, uid: 1000, privileged: true }, { execute } )
        expect( result.name ).toBe( `babysit-recover-1000.service` )
        expect( calls.slice( 1 ) ).toEqual( [ [ `systemctl`, `daemon-reload` ], [ `systemctl`, `enable`, result.name ] ] )
        expect( existsSync( staged ) ).toBe( false )
    } )

    it( `fails before installing when sudo cannot run noninteractively`, async () => {
        const calls = []
        await expect( install_recovery_service( { unit: render_recovery_service( settings ), uid: 1000, privileged: false }, {
            execute: async ( command, args ) => {
                calls.push( [ command, ...args ] )
                throw new Error( `sudo requires a password` )
            },
        } ) ).rejects.toThrow( `password` )
        expect( calls ).toEqual( [ [ `sudo`, `-n`, `true` ] ] )
    } )
} )
