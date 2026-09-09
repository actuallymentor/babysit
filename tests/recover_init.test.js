import { describe, expect, it } from 'bun:test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { check_recovery_environment, install_recovery_service, render_recovery_service } from '../src/cli/recover_init.js'

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
            if( command === `/usr/bin/install` ) {
                staged = args.at( -2 )
                expect( readFileSync( staged, `utf8` ) ).toBe( unit )
            }
        }
        const result = await install_recovery_service( { unit, uid: 1000, privileged: true }, { execute } )
        expect( result.name ).toBe( `babysit-recover-1000.service` )
        expect( calls.slice( 1 ) ).toEqual( [ [ `/usr/bin/systemctl`, `daemon-reload` ], [ `/usr/bin/systemctl`, `enable`, result.name ] ] )
        expect( existsSync( staged ) ).toBe( false )
    } )

    it( `fails before installing when sudo cannot run noninteractively`, async () => {
        const calls = []
        const error = await install_recovery_service( { unit: render_recovery_service( settings ), uid: 1000, privileged: false }, {
            interactive: false,
            execute: async ( command, args ) => {
                calls.push( [ command, ...args ] )
                throw new Error( `sudo requires a password` )
            },
        } ).catch( error => error )
        expect( error.message ).toContain( `Run babysit recover init in a terminal` )
        expect( error.message ).toContain( `sudo requires a password` )
        expect( calls ).toEqual( [ [ `/usr/bin/sudo`, `-n`, `-v` ] ] )
    } )

    it( `authenticates through the user's terminal before installing`, async () => {
        const calls = []
        await install_recovery_service( { unit: render_recovery_service( settings ), uid: 1000, privileged: false }, {
            interactive: true,
            execute: async ( command, args, options, timeout ) => calls.push( { command, args, options, timeout } ),
        } )
        expect( calls[ 0 ] ).toEqual( { command: `/usr/bin/sudo`, args: [ `-v` ], options: { stdio: [ `inherit`, `pipe`, `pipe` ] }, timeout: 300_000 } )
        expect( calls.slice( 1 ).map( call => call.args.slice( 0, 2 ) ) ).toEqual( [ [ `--`, `/usr/bin/install` ], [ `--`, `/usr/bin/systemctl` ], [ `--`, `/usr/bin/systemctl` ] ] )
        expect( calls.every( call => !call.args.includes( `-n` ) ) ).toBe( true )
    } )

    it( `does not install after terminal authentication fails`, async () => {
        let attempts = 0
        await expect( install_recovery_service( { unit: `unit`, uid: 1000, privileged: false }, {
            interactive: true,
            execute: async () => { attempts++; throw new Error( `authentication failed` ) },
        } ) ).rejects.toThrow( `Sudo authentication failed` )
        expect( attempts ).toBe( 1 )
    } )
} )

describe( `boot recovery prerequisites`, () => {
    const account = { ...settings, username: `alice` }

    it( `checks executables with a clean environment after dropping sudo privileges`, async () => {
        const calls = []
        const dependencies = await check_recovery_environment( account, {
            current_uid: 0,
            execute: async ( binary, args, options ) => {
                calls.push( { binary, args, options } )
                return args.includes( `command -v "$1"` ) ? `/usr/bin/${ args.at( -1 ) }` : `ok`
            },
        } )
        expect( dependencies ).toEqual( [ `/usr/bin/sh`, `/usr/bin/tmux`, `/usr/bin/docker`, `/usr/bin/cat`, `/usr/bin/ps` ] )
        for( const call of calls ) {
            expect( call.binary ).toBe( `/usr/sbin/runuser` )
            expect( call.args.slice( 0, 5 ) ).toEqual( [ `--user`, `alice`, `--`, `/usr/bin/env`, `-i` ] )
            expect( call.args ).toContain( `HOME=/home/alice` )
            expect( call.args ).toContain( `PATH=/usr/bin:/bin` )
            expect( call.options ).toEqual( { cwd: `/home/alice` } )
        }
        expect( calls[ 1 ].args.slice( -2 ) ).toEqual( [ `/usr/bin/true`, `--version` ] )
        expect( calls.at( -1 ).args.slice( -6 ) ).toEqual( [ `docker`, `--host`, `unix:///var/run/docker.sock`, `info`, `--format`, `{{.ID}}` ] )
    } )

    it( `explains stripped PATH failures before any privileged installation`, async () => {
        const calls = []
        const error = await check_recovery_environment( account, {
            current_uid: 1000,
            execute: async ( binary, args ) => {
                calls.push( binary )
                if( args.at( -1 ) === `tmux` ) throw new Error( `tmux unavailable` )
                return args.includes( `command -v "$1"` ) ? `/usr/bin/${ args.at( -1 ) }` : `ok`
            },
        } ).catch( error => error )
        expect( error.message ).toContain( `tmux on the service PATH` )
        expect( error.message ).toContain( `as alice without a sudo prefix` )
        expect( calls.every( binary => binary === `/usr/bin/env` ) ).toBe( true )
    } )

    it( `actually rejects a runtime that relies on login-only environment`, async () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-boot-env-` ) )
        const previous = process.env.BABYSIT_BOOT_TEST_LOGIN
        try {
            process.env.BABYSIT_BOOT_TEST_LOGIN = `yes`
            const script = join( directory, `needs-login.js` )
            writeFileSync( script, `if (!process.env.PATH || process.env.HOME !== ${ JSON.stringify( directory ) }) process.exit(2); process.exit(process.env.BABYSIT_BOOT_TEST_LOGIN ? 0 : 7)` )
            const result = spawnSync( process.execPath, [ script ], { env: { ...process.env, HOME: directory, BABYSIT_BOOT_TEST_LOGIN: `yes` } } )
            expect( result.status ).toBe( 0 )
            await expect( check_recovery_environment( {
                ...account, uid: process.getuid(), home: directory, command: [ process.execPath, script ],
            } ) ).rejects.toThrow( `Babysit executable` )
        } finally {
            if( previous === undefined ) delete process.env.BABYSIT_BOOT_TEST_LOGIN
            else process.env.BABYSIT_BOOT_TEST_LOGIN = previous
            rmSync( directory, { recursive: true, force: true } )
        }
    } )
} )
