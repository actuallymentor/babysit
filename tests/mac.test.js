import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { add_mac, forget_mac, list_macs, setup_mac_credentials, MAC_BOOTSTRAP_PATH } from '../src/mac/store.js'
import { run_mac } from '../src/docker/assets/mac/command.mjs'
import { cmd_mac } from '../src/cli/mac.js'
import { parse_args } from '../src/cli/parse.js'
import { build_system_prompt } from '../src/modes/prompt.js'
import { build_docker_launch_plan } from '../src/docker/launch.js'

const SECRET = `hunter2-do-not-leak`

describe( `babysit mac`, () => {

    let dir
    beforeEach( () => { dir = mkdtempSync( join( tmpdir(), `babysit-mac-test-` ) ) } )
    afterEach( () => rmSync( dir, { recursive: true, force: true } ) )

    const add = ( name = `office` ) => add_mac( { name, host: `192.168.2.236`, user: `mentor`, password: SECRET }, dir )

    describe( `store`, () => {

        it( `keeps secrets out of the registry and private on disk`, () => {
            add()
            expect( readFileSync( join( dir, `macs.json` ), `utf8` ) ).not.toContain( SECRET )
            expect( list_macs( dir ) ).toEqual( [ { name: `office`, host: `192.168.2.236`, user: `mentor` } ] )
            expect( statSync( join( dir, `office` ) ).mode & 0o777 ).toBe( 0o700 )
            for( const file of [ `password`, `id_ed25519` ] ) expect( statSync( join( dir, `office`, file ) ).mode & 0o777 ).toBe( 0o600 )
        } )

        it( `re-adding replaces the password and keeps the key`, () => {
            add()
            const key = readFileSync( join( dir, `office`, `id_ed25519.pub` ), `utf8` )
            add_mac( { name: `office`, host: `10.0.0.5`, user: `mentor`, password: `other` }, dir )
            expect( readFileSync( join( dir, `office`, `id_ed25519.pub` ), `utf8` ) ).toBe( key )
            expect( readFileSync( join( dir, `office`, `password` ), `utf8` ) ).toBe( `other` )
            expect( list_macs( dir ) ).toHaveLength( 1 )
        } )

        it( `rejects names, hosts and users that could escape or become ssh options`, () => {
            const bad = overrides => () => add_mac( { name: `a`, host: `h`, user: `u`, password: `p`, ...overrides }, dir )
            expect( bad( { name: `../x` } ) ).toThrow()
            expect( bad( { host: `-oProxyCommand=x` } ) ).toThrow()
            expect( bad( { user: `a b` } ) ).toThrow()
            expect( bad( { password: `a\nb` } ) ).toThrow()
        } )

        it( `forgets a Mac and its secrets`, () => {
            add()
            expect( forget_mac( `office`, dir ) ).toBe( true )
            expect( existsSync( join( dir, `office` ) ) ).toBe( false )
            expect( forget_mac( `office`, dir ) ).toBe( false )
        } )

        it( `stages nothing without registered Macs, else one private copy upload`, () => {
            expect( setup_mac_credentials( { dir } ) ).toEqual( [] )

            add()
            const [ mount ] = setup_mac_credentials( { dir } )
            expect( mount ).toMatchObject( { type: `copy`, target: MAC_BOOTSTRAP_PATH } )
            expect( statSync( mount.cleanup ).mode & 0o777 ).toBe( 0o700 )
            expect( readFileSync( join( mount.cleanup, `mac`, `office`, `password` ), `utf8` ) ).toBe( SECRET )
            rmSync( mount.cleanup, { recursive: true, force: true } )
        } )

        it( `the staged upload never reaches Docker flags or env`, () => {
            add()
            const mounts = setup_mac_credentials( { dir } )
            const plan = build_docker_launch_plan( { agent: { name: `claude` }, mode: {}, extra_mounts: [], creds_mounts: mounts } )
            expect( JSON.stringify( plan.creds_mounts ) ).not.toContain( SECRET )
            rmSync( mounts[0].cleanup, { recursive: true, force: true } )
        } )

    } )

    describe( `in-container command`, () => {

        const run = async ( args ) => {
            const calls = []
            const code = await run_mac( args, {
                root: dir,
                say: () => {},
                run: async ( command, argv, options ) => ( calls.push( { command, argv, options } ), 0 ),
                reachable: async () => true,
            } )
            return { code, calls }
        }

        it( `ssh uses the key, a pinned known_hosts file and never prompts`, async () => {
            add()
            const { calls } = await run( [ `ssh`, `office`, `uname -a` ] )
            expect( calls[0].command ).toBe( `ssh` )
            expect( calls[0].argv ).toContain( `${ dir }/office/id_ed25519` )
            expect( calls[0].argv ).toContain( `BatchMode=yes` )
            expect( calls[0].argv.slice( -2 ) ).toEqual( [ `mentor@192.168.2.236`, `uname -a` ] )
        } )

        it( `sudo feeds the password on stdin, never argv`, async () => {
            add()
            const { calls } = await run( [ `sudo`, `office`, `launchctl`, `list` ] )
            expect( JSON.stringify( calls[0].argv ) ).not.toContain( SECRET )
            expect( calls[0].options.input ).toBe( `${ SECRET }\n` )
            expect( calls[0].argv.slice( -6 ) ).toEqual( [ `sudo`, `-S`, `-p`, `''`, `launchctl`, `list` ] )
        } )

        it( `scp rewrites mac: paths to user@host:`, async () => {
            add()
            const { calls } = await run( [ `scp`, `office`, `mac:/tmp/a.png`, `./a.png` ] )
            expect( calls[0].argv.slice( -2 ) ).toEqual( [ `mentor@192.168.2.236:/tmp/a.png`, `./a.png` ] )
        } )

        it( `GUI actions go to the vnc helper by Mac name`, async () => {
            add()
            const { calls } = await run( [ `click`, `office`, `10`, `20`, `right` ] )
            expect( calls[0].command ).toBe( `python3` )
            expect( calls[0].argv.slice( 1 ) ).toEqual( [ `office`, `click`, `10`, `20`, `right` ] )
        } )

        it( `explains when the session has no Macs or an unknown name`, async () => {
            await expect( run( [ `ssh`, `office`, `true` ] ) ).rejects.toThrow( `--mac` )
            add()
            await expect( run( [ `ssh`, `nope`, `true` ] ) ).rejects.toThrow( `registered: office` )
        } )

    } )

    describe( `host command`, () => {

        it( `parses add, list, check and forget`, () => {
            expect( parse_args( [ `mac`, `add`, `office`, `10.0.0.5`, `--user`, `me`, `--password-env`, `PW` ] ) )
                .toMatchObject( { verb: `mac`, mac_verb: `add`, mac_name: `office`, mac_host: `10.0.0.5`, user: `me`, password_env: `PW` } )
            expect( parse_args( [ `mac`, `list` ] ).mac_verb ).toBe( `list` )
            expect( () => parse_args( [ `mac`, `add`, `office` ] ) ).toThrow( `Usage` )
            expect( () => parse_args( [ `mac`, `forget` ] ) ).toThrow( `NAME` )
            expect( () => parse_args( [ `mac`, `bogus` ] ) ).toThrow( `Unknown mac command` )
        } )

        it( `add reads the password from the pipe seam and reports a missing Remote Login`, async () => {
            const lines = []
            const code = await cmd_mac(
                { mac_verb: `add`, mac_name: `office`, mac_host: `192.168.2.236`, user: `mentor`, password_stdin: true },
                { dir, print: line => lines.push( line ), ports: async () => false, read_password: () => SECRET }
            )
            expect( code ).toBe( 1 )
            expect( readFileSync( join( dir, `office`, `password` ), `utf8` ) ).toBe( SECRET )
            expect( lines.join( `\n` ) ).not.toContain( SECRET )
            expect( lines.join( `\n` ) ).toContain( `Remote Login` )
        } )

    } )

    describe( `flags and prompt`, () => {

        it( `--mac enables Mac only, --devices enables every kind, --no-mac drops it`, () => {
            expect( parse_args( [ `claude`, `--mac` ] ).flags ).toMatchObject( { mac: true, adb: false, ios: false } )
            expect( parse_args( [ `claude`, `--devices` ].concat( [] ) ).flags ).toMatchObject( { mac: true, adb: true, ios: true } )
            expect( parse_args( [ `claude` ] ).flags.mac ).toBe( false )
        } )

        it( `only a --mac session is told about Macs`, () => {
            expect( build_system_prompt( { mac: true } ) ).toContain( `babysit mac ssh NAME` )
            expect( build_system_prompt( { mac: true } ) ).toContain( `never destroy or alter anyone else's data` )
            expect( build_system_prompt( {} ) ).not.toContain( `babysit mac` )
        } )

    } )

} )
