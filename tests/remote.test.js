import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { add_mac, forget_mac, list_macs, set_mac_enabled, setup_mac_credentials, MAC_BOOTSTRAP_PATH, MAC_CONTAINER_DIR, REMOTE_KINDS, add_remote, list_remotes, setup_remote_credentials } from '../src/remote/store.js'
import { run_mac, run_windows } from '../src/docker/assets/remote/command.mjs'
import { authorize_windows, cmd_mac, cmd_windows } from '../src/cli/remote.js'
import { get_agent } from '../src/agents/index.js'
import { parse_args } from '../src/cli/parse.js'
import { build_system_prompt } from '../src/modes/prompt.js'
import { build_docker_launch_plan } from '../src/docker/launch.js'
import { build_docker_command_args } from '../src/docker/run.js'
import { cleanup_stale_ephemeral_credential_mounts } from '../src/credentials/index.js'
import { DEVICE_KINDS, all_devices, every_device } from '../src/devices/kinds.js'

const SECRET = `hunter2-do-not-leak`

describe( `babysit mac`, () => {

    // Every test gets its own store and its own TMPDIR, so staged credential
    // directories can never leak into the shared /tmp, even when an assertion fails early
    let dir
    let scratch
    let original_tmpdir
    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-mac-test-` ) )
        scratch = mkdtempSync( join( tmpdir(), `babysit-mac-scratch-` ) )
        original_tmpdir = process.env.TMPDIR
        process.env.TMPDIR = scratch
    } )
    afterEach( () => {
        if( original_tmpdir === undefined ) delete process.env.TMPDIR
        else process.env.TMPDIR = original_tmpdir
        rmSync( dir, { recursive: true, force: true } )
        rmSync( scratch, { recursive: true, force: true } )
    } )

    const add = ( name = `office` ) => add_mac( { name, host: `192.168.1.50`, user: `mentor`, password: SECRET }, dir )

    describe( `store`, () => {

        it( `keeps secrets out of the registry and private on disk`, () => {
            add()
            expect( readFileSync( join( dir, `macs.json` ), `utf8` ) ).not.toContain( SECRET )
            expect( list_macs( dir ) ).toEqual( [ { name: `office`, host: `192.168.1.50`, user: `mentor` } ] )
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
            expect( readFileSync( join( mount.cleanup, `office`, `password` ), `utf8` ) ).toBe( SECRET )
            expect( JSON.parse( readFileSync( join( mount.cleanup, `macs.json` ), `utf8` ) ).macs ).toEqual( [ { name: `office`, host: `192.168.1.50`, user: `mentor` } ] )
            rmSync( mount.cleanup, { recursive: true, force: true } )
        } )

        it( `disabled Macs stay registered but never leave the host`, () => {
            add( `office` )
            add( `lab` )
            expect( set_mac_enabled( `lab`, false, dir ) ).toBe( true )
            expect( list_macs( dir ).find( mac => mac.name === `lab` ).enabled ).toBe( false )

            const [ mount ] = setup_mac_credentials( { dir } )
            expect( existsSync( join( mount.cleanup, `office`, `password` ) ) ).toBe( true )
            expect( existsSync( join( mount.cleanup, `lab` ) ) ).toBe( false )
            expect( readFileSync( join( mount.cleanup, `macs.json` ), `utf8` ) ).not.toContain( `lab` )
            rmSync( mount.cleanup, { recursive: true, force: true } )

            // A password change keeps it disabled; enabling restores it
            add( `lab` )
            expect( list_macs( dir ).find( mac => mac.name === `lab` ).enabled ).toBe( false )
            set_mac_enabled( `lab`, true, dir )
            expect( list_macs( dir ).find( mac => mac.name === `lab` ).enabled ).toBeUndefined()
            expect( set_mac_enabled( `ghost`, false, dir ) ).toBe( false )

            set_mac_enabled( `office`, false, dir )
            set_mac_enabled( `lab`, false, dir )
            expect( setup_mac_credentials( { dir } ) ).toEqual( [] )
        } )

        it( `the staging directory is a swept ephemeral transport, so a crash cannot strand secrets`, () => {
            add()
            // Isolated TMPDIR: never sweep the real, shared /tmp from a test
            const scratch = mkdtempSync( join( tmpdir(), `mac-sweep-` ) )
            const original = process.env.TMPDIR
            process.env.TMPDIR = scratch
            try {
                const [ mount ] = setup_mac_credentials( { dir } )
                expect( mount.cleanup.startsWith( scratch ) ).toBe( true )
                expect( mount.cleanup ).toContain( `babysit-mac-creds-` )
                expect( cleanup_stale_ephemeral_credential_mounts( { directory: scratch, max_age_ms: -1 } ) ).toBe( 1 )
                expect( existsSync( mount.cleanup ) ).toBe( false )
            } finally {
                if( original === undefined ) delete process.env.TMPDIR
                else process.env.TMPDIR = original
                rmSync( scratch, { recursive: true, force: true } )
            }
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
            expect( calls[0].argv.slice( -2 ) ).toEqual( [ `mentor@192.168.1.50`, `uname -a` ] )
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
            expect( calls[0].argv.slice( -2 ) ).toEqual( [ `mentor@192.168.1.50:/tmp/a.png`, `./a.png` ] )
        } )

        it( `GUI actions go to the vnc helper by Mac name`, async () => {
            add()
            const { calls } = await run( [ `click`, `office`, `10`, `20`, `right` ] )
            expect( calls[0].command ).toBe( `python3` )
            expect( calls[0].argv.slice( 1 ) ).toEqual( [ `--kind`, `mac`, `office`, `click`, `10`, `20`, `right` ] )
        } )

        it( `password goes to the vnc helper without the secret in argv`, async () => {
            add()
            const { calls } = await run( [ `password`, `office` ] )
            expect( calls[0].argv.slice( 1 ) ).toEqual( [ `--kind`, `mac`, `office`, `password` ] )
        } )

        it( `run chains GUI actions through one vnc invocation`, async () => {
            add()
            const { calls } = await run( [ `run`, `office`, `click 10 20; type hi; shot` ] )
            expect( calls ).toHaveLength( 1 )
            expect( calls[0].argv.slice( 1 ) ).toEqual( [ `--kind`, `mac`, `office`, `run`, `click 10 20; type hi; shot` ] )
        } )

        it( `explains when the session has no Macs or an unknown name`, async () => {
            await expect( run( [ `ssh`, `office`, `true` ] ) ).rejects.toThrow( `--mac` )
            process.env.BABYSIT_MAC = `1`
            await expect( run( [ `ssh`, `office`, `true` ] ) ).rejects.toThrow( `Relaunch the session` )
            delete process.env.BABYSIT_MAC
            add()
            await expect( run( [ `ssh`, `nope`, `true` ] ) ).rejects.toThrow( `registered: office` )
        } )

    } )

    describe( `vnc helper logic`, () => {

        // Pure functions in vnc.py, run through python3 (no VNC, no PIL needed)
        const py = code => spawnSync( `python3`, [ `-I`, `-c`, `import sys, json; sys.path.insert(0, 'src/docker/assets/remote'); import vnc\n${ code }` ], { encoding: `utf8` } )
        const json = code => JSON.parse( py( `print(json.dumps(${ code }))` ).stdout )

        it( `password types the stored secret as keystrokes and prints nothing`, () => {
            // Fake asyncvnc + connection: record key-down keysyms
            const result = py( `
import asyncio, types
sys.modules['asyncvnc'] = types.SimpleNamespace(key_codes={})
vnc.KINDS['mac']['warmup'] = vnc.SETTLE = vnc.KEY_DELAY = 0
sent = []
async def drain(): pass
writer = types.SimpleNamespace(write=lambda b: b[1] == 1 and sent.append(int.from_bytes(b[4:], 'big')))
fake = types.SimpleNamespace(keyboard=types.SimpleNamespace(writer=writer), drain=drain)
asyncio.run(vnc.act(fake, {'name': 'office'}, 'S3cr;t!', 'password', [], 0))
sys.stderr.write(''.join(map(chr, sent)))` )
            expect( result.stderr ).toBe( `S3cr;t!` )
            expect( result.stdout ).toBe( `` )
        } )

        it( `splits scripts on ; and newlines outside quotes and skips comments`, () => {
            const [ script, empty ] = json( `[vnc.parse_script('click 10 20; type "a; b"\\n# note\\nkey Return'), vnc.parse_script('  ;; ')]` )
            expect( script ).toEqual( [ [ `click`, `10`, `20` ], [ `type`, `a; b` ], [ `key`, `Return` ] ] )
            expect( empty ).toEqual( [] )
        } )

        it( `shrinks shots to the edge limit and maps clicks back to framebuffer pixels`, () => {
            const [ retina, hd, small, mapped ] = json( `[vnc.shot_scale(3360, 2100, 1568), vnc.shot_scale(1920, 1080, 1568), vnc.shot_scale(800, 600, 1568), vnc.to_framebuffer(100, 50, 2.1429)]` )
            expect( retina ).toBeCloseTo( 2.1429, 3 )
            expect( hd ).toBeCloseTo( 1.2245, 3 )
            expect( small ).toBe( 1 )
            expect( mapped ).toEqual( [ 214, 107 ] )
        } )

        it( `finds the lock screen's submit arrow at both screen sizes`, () => {
            const [ retina, hd ] = json( `[vnc.lock_arrow(3360, 2100), vnc.lock_arrow(1920, 1080)]` )
            expect( retina[0] ).toBeGreaterThan( 1790 ) // measured: arrow centre ~ (1805, 1907)
            expect( retina[0] ).toBeLessThan( 1820 )
            expect( Math.abs( retina[1] - 1907 ) ).toBeLessThan( 5 )
            expect( Math.abs( hd[0] - 1025 ) ).toBeLessThan( 10 ) // measured ~ (1025, 981)
            expect( Math.abs( hd[1] - 981 ) ).toBeLessThan( 5 )
        } )

        it( `maps single characters straight to Unicode keysyms and parses chords`, () => {
            const [ keys, named, chords ] = json( `[[vnc.keysym('c', {}), vnc.keysym('H', {}), vnc.keysym('$', {}), vnc.keysym('\\u20ac', {})], vnc.keysym('Return', {'Return': 65293}), [vnc.parse_chord('Cmd+space'), vnc.parse_chord('+'), vnc.parse_chord('Cmd++')]]` )
            expect( keys ).toEqual( [ 0x63, 0x48, 0x24, 0x010020ac ] )
            expect( named ).toBe( 65293 )
            expect( chords ).toEqual( [ [ `Cmd`, `space` ], [ `+` ], [ `Cmd`, `+` ] ] )
        } )

    } )

    describe( `host command`, () => {

        it( `parses add, list, check and forget`, () => {
            expect( parse_args( [ `mac`, `add`, `office`, `10.0.0.5`, `--user`, `me`, `--password-env`, `PW` ] ) )
                .toMatchObject( { verb: `mac`, remote_verb: `add`, remote_name: `office`, remote_host: `10.0.0.5`, user: `me`, password_env: `PW` } )
            expect( parse_args( [ `mac`, `list` ] ).remote_verb ).toBe( `list` )
            expect( () => parse_args( [ `mac`, `add`, `office` ] ) ).toThrow( `Usage` )
            expect( () => parse_args( [ `mac`, `forget` ] ) ).toThrow( `NAME` )
            expect( () => parse_args( [ `mac`, `bogus` ] ) ).toThrow( `Unknown mac command` )
        } )

        it( `parses enable and disable, which need a name`, () => {
            expect( parse_args( [ `mac`, `disable`, `office` ] ) ).toMatchObject( { remote_verb: `disable`, remote_name: `office` } )
            expect( () => parse_args( [ `mac`, `enable` ] ) ).toThrow( `NAME` )
        } )

        it( `enable and disable flip what sessions receive`, async () => {
            add()
            const lines = []
            const deps = { dir, print: line => lines.push( line ), ports: async () => true }
            expect( await cmd_mac( { remote_verb: `disable`, remote_name: `office` }, deps ) ).toBe( 0 )
            expect( setup_mac_credentials( { dir } ) ).toEqual( [] )
            await cmd_mac( { remote_verb: `list` }, deps )
            expect( lines.join( `\n` ) ).toContain( `disabled` )
            expect( await cmd_mac( { remote_verb: `enable`, remote_name: `office` }, deps ) ).toBe( 0 )
            expect( setup_mac_credentials( { dir } ) ).toHaveLength( 1 )
            expect( await cmd_mac( { remote_verb: `enable`, remote_name: `ghost` }, deps ) ).toBe( 1 )
        } )

        it( `add refuses to prompt: the password needs a pipe or an environment variable`, async () => {
            await expect( cmd_mac( { remote_verb: `add`, remote_name: `office`, remote_host: `10.0.0.5` }, { dir } ) ).rejects.toThrow( `--password-stdin` )
            expect( list_macs( dir ) ).toEqual( [] )
        } )

        it( `add reads the password from the pipe seam and reports a missing Remote Login`, async () => {
            const lines = []
            const code = await cmd_mac(
                { remote_verb: `add`, remote_name: `office`, remote_host: `192.168.1.50`, user: `mentor`, password_stdin: true },
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

        it( `the mode descriptor and prompt derive from the device table`, () => {
            expect( DEVICE_KINDS.map( kind => kind.name ) ).toEqual( [ `adb`, `ios`, `mac`, `windows` ] )
            expect( all_devices( { adb: true, ios: true, mac: true, windows: true } ) ).toBe( true )
            expect( all_devices( { adb: true, ios: true, mac: true } ) ).toBe( false )
            expect( every_device( false ) ).toEqual( { adb: false, ios: false, mac: false, windows: false } )
            for( const { name, prompt } of DEVICE_KINDS ) expect( build_system_prompt( { [ name ]: true } ) ).toContain( prompt )
        } )

        it( `a --mac container gets the marker and a memory-only credential directory`, () => {
            const args = build_docker_command_args( {
                agent: get_agent( `claude` ), workspace: `/tmp/ws`, mode: { sandbox: true, mac: true },
                mount_workspace: false, include_agent_state: false, include_agents_dir: false, include_babysit_rc: false, include_loop_deadline: false,
                extra_mounts: [], chrome_seccomp_profile_path: `/tmp/seccomp.json`,
            } )
            expect( args ).toContain( `BABYSIT_MAC=1` )
            expect( args[ args.indexOf( `--tmpfs` ) + 1 ] ).toStartWith( `${ MAC_CONTAINER_DIR }:` )
            expect( args.join( ` ` ) ).not.toContain( SECRET )
            expect( build_docker_command_args( {
                agent: get_agent( `claude` ), workspace: `/tmp/ws`, mode: { sandbox: true },
                mount_workspace: false, include_agent_state: false, include_agents_dir: false, include_babysit_rc: false, include_loop_deadline: false,
                extra_mounts: [], chrome_seccomp_profile_path: `/tmp/seccomp.json`,
            } ) ).not.toContain( `--tmpfs` )
        } )

        it( `only a --mac session is told about Macs`, () => {
            expect( build_system_prompt( { mac: true } ) ).toContain( `babysit mac --help` )
            expect( build_system_prompt( { mac: true } ) ).toContain( `touch nothing outside your home or /tmp` )
            expect( build_system_prompt( { mac: true } ) ).toContain( `screenshot and read typed text before pressing Return` )
            expect( build_system_prompt( {} ) ).not.toContain( `babysit mac` )
        } )

    } )

} )

describe( `babysit windows`, () => {

    const WINDOWS = REMOTE_KINDS.windows
    const decode = base64 => Buffer.from( base64, `base64` ).toString( `utf16le` )

    let dir
    let scratch
    let original_tmpdir
    beforeEach( () => {
        dir = mkdtempSync( join( tmpdir(), `babysit-windows-test-` ) )
        scratch = mkdtempSync( join( tmpdir(), `babysit-windows-scratch-` ) )
        original_tmpdir = process.env.TMPDIR
        process.env.TMPDIR = scratch
    } )
    afterEach( () => {
        if( original_tmpdir === undefined ) delete process.env.TMPDIR
        else process.env.TMPDIR = original_tmpdir
        rmSync( dir, { recursive: true, force: true } )
        rmSync( scratch, { recursive: true, force: true } )
    } )

    const add = ( name = `laptop` ) => add_remote( WINDOWS, { name, host: `192.168.2.85`, user: `mentor`, password: SECRET }, dir )

    it( `keeps its own registry, separate from Macs`, () => {
        add()
        expect( JSON.parse( readFileSync( join( dir, `windows.json` ), `utf8` ) ) ).toEqual( { machines: [ { name: `laptop`, host: `192.168.2.85`, user: `mentor` } ] } )
        expect( list_macs( dir ) ).toEqual( [] )
        expect( list_remotes( WINDOWS, dir ).map( machine => machine.name ) ).toEqual( [ `laptop` ] )
    } )

    it( `stages secrets for the windows bootstrap path only`, () => {
        add()
        const [ mount ] = setup_remote_credentials( WINDOWS, { dir } )
        expect( mount.target ).toBe( `/tmp/.babysit-windows` )
        expect( mount.cleanup ).toContain( `babysit-windows-creds-` )
        expect( existsSync( join( mount.cleanup, `windows.json` ) ) ).toBe( true )
        expect( readFileSync( join( mount.cleanup, `laptop`, `password` ), `utf8` ) ).toBe( SECRET )
    } )

    it( `authorizes the key with an encoded PowerShell script for admins and standard users`, () => {
        const command = authorize_windows( `ssh-ed25519 AAAA babysit-windows-laptop` )
        const [ , encoded ] = command.match( /-EncodedCommand (\S+)$/ )
        const script = decode( encoded )
        expect( command ).toStartWith( `powershell -NoProfile -NonInteractive -EncodedCommand ` )
        expect( script ).toContain( `$k = 'ssh-ed25519 AAAA babysit-windows-laptop'` )
        expect( script ).toContain( `administrators_authorized_keys` )
        expect( script ).toContain( `authorized_keys` )
        expect( script ).toContain( `SetAccessRuleProtection($true, $false)` )
        expect( script ).toContain( `'S-1-5-32-544', 'S-1-5-18'` )
        expect( script ).toContain( `EndsWith` )
    } )

    describe( `in-container command`, () => {

        const run = async ( args, extra = {} ) => {
            const calls = []
            const code = await run_windows( args, {
                root: dir,
                say: () => {},
                run: async ( command, argv, options ) => ( calls.push( { command, argv, options } ), 0 ),
                reachable: async () => true,
                ...extra,
            } )
            return { code, calls }
        }

        it( `ps streams the script over stdin to a fixed encoded launcher`, async () => {
            add()
            const long = `Write-Output '${ `x`.repeat( 9_000 ) }'`
            const { calls } = await run( [ `ps`, `laptop`, long ] )
            const { argv, options } = calls[0]
            expect( argv.slice( -6, -1 ) ).toEqual( [ `mentor@192.168.2.85`, `powershell`, `-NoProfile`, `-NonInteractive`, `-EncodedCommand` ] )
            expect( decode( argv.at( -1 ) ) ).toContain( `Invoke-Expression $reader.ReadToEnd()` )
            expect( argv.join( ` ` ).length ).toBeLessThan( 2_000 )
            expect( options.input ).toBe( long )
        } )

        it( `ps reads the script from stdin when no argument is given`, async () => {
            add()
            const { calls } = await run( [ `ps`, `laptop` ], { stdin: async () => `hostname` } )
            expect( calls[0].options.input ).toBe( `hostname` )
        } )

        it( `has no sudo, rewrites win: scp paths, and sends GUI actions with --kind windows`, async () => {
            add()
            await expect( run( [ `sudo`, `laptop`, `whoami` ] ) ).rejects.toThrow( `Unknown windows command sudo` )
            const { calls: scp } = await run( [ `scp`, `laptop`, `win:C:/Users/mentor/a.png`, `./a.png` ] )
            expect( scp[0].argv.slice( -2 ) ).toEqual( [ `mentor@192.168.2.85:C:/Users/mentor/a.png`, `./a.png` ] )
            const { calls: gui } = await run( [ `shot`, `laptop` ] )
            expect( gui[0].argv.slice( 1 ) ).toEqual( [ `--kind`, `windows`, `laptop`, `shot` ] )
        } )

        it( `explains a session without Windows PCs`, async () => {
            await expect( run( [ `ps`, `laptop`, `hostname` ] ) ).rejects.toThrow( `--windows` )
        } )

    } )

    it( `vnc helper: --kind selects the registry, Win maps to Super, unlock submits with Return`, () => {
        const py = code => spawnSync( `python3`, [ `-I`, `-c`, `import sys, json; sys.path.insert(0, 'src/docker/assets/remote'); import vnc\n${ code }` ], { encoding: `utf8` } )
        const parsed = JSON.parse( py( `print(json.dumps([vnc.parse_kind(['--kind', 'windows', 'laptop', 'shot']), vnc.parse_kind(['office', 'shot']), vnc.keysym('Win', {'Super_L': 65515})]))` ).stdout )
        expect( parsed ).toEqual( [ [ `windows`, [ `laptop`, `shot` ] ], [ `mac`, [ `office`, `shot` ] ], 65515 ] )

        const result = py( `
import asyncio, types
sys.modules['asyncvnc'] = types.SimpleNamespace(key_codes={'space': 32, 'Return': 65293, 'Ctrl': 65507, 'BackSpace': 65288})
vnc.KIND = 'windows'
vnc.KINDS['windows']['warmup'] = vnc.SETTLE = vnc.KEY_DELAY = 0
real_sleep = asyncio.sleep
asyncio.sleep = lambda seconds: real_sleep(0)
sent = []
async def drain(): pass
writer = types.SimpleNamespace(write=lambda b: b[1] == 1 and sent.append(int.from_bytes(b[4:], 'big')))
fake = types.SimpleNamespace(keyboard=types.SimpleNamespace(writer=writer), drain=drain)
asyncio.run(vnc.act(fake, {'name': 'laptop'}, 'pw', 'unlock', [], 0))
print(json.dumps(sent))` )
        expect( JSON.parse( result.stdout ) ).toEqual( [ 32, 65507, 0x61, 65288, 0x70, 0x77, 65293 ] )
    }, 20_000 )

    it( `host command parses, and add reports a missing OpenSSH Server`, async () => {
        expect( parse_args( [ `windows`, `add`, `laptop`, `192.168.2.85`, `--user`, `mentor`, `--password-stdin` ] ) )
            .toMatchObject( { verb: `windows`, remote_verb: `add`, remote_name: `laptop`, remote_host: `192.168.2.85`, user: `mentor`, password_stdin: true } )
        expect( () => parse_args( [ `windows`, `forget` ] ) ).toThrow( `needs a NAME` )

        const lines = []
        const code = await cmd_windows(
            { remote_verb: `add`, remote_name: `laptop`, remote_host: `192.168.2.85`, user: `mentor`, password_stdin: true },
            { dir, print: line => lines.push( line ), ports: async () => false, read_password: () => SECRET },
        )
        expect( code ).toBe( 1 )
        expect( lines.join( `\n` ) ).toContain( `OpenSSH Server` )
        expect( lines.join( `\n` ) ).toContain( `TightVNC` )
        expect( lines.join( `\n` ) ).not.toContain( SECRET )
    } )

    it( `a --windows container gets its marker and tmpfs; --devices includes it`, () => {
        const args = build_docker_command_args( {
            agent: get_agent( `claude` ), workspace: `/tmp/ws`, mode: { sandbox: true, windows: true },
            mount_workspace: false, include_agent_state: false, include_agents_dir: false, include_babysit_rc: false, include_loop_deadline: false,
            extra_mounts: [], chrome_seccomp_profile_path: `/tmp/seccomp.json`,
        } )
        expect( args ).toContain( `BABYSIT_WINDOWS=1` )
        expect( args ).not.toContain( `BABYSIT_MAC=1` )
        expect( args[ args.indexOf( `--tmpfs` ) + 1 ] ).toStartWith( `${ WINDOWS.container_dir }:` )
        expect( parse_args( [ `claude`, `--devices` ] ).flags.windows ).toBe( true )
        expect( build_system_prompt( { windows: true } ) ).toContain( `babysit windows --help` )
        expect( build_system_prompt( { mac: true } ) ).not.toContain( `babysit windows` )
    } )

} )
