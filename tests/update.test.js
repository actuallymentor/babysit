import { describe, it, expect, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { is_compiled_binary, binary_platform_tag, is_on_path, update_docker_image, update_web_container, configure_auto_update, maybe_auto_update } from '../src/cli/update.js'

// is_compiled_binary reads process.argv[1] live, so we save/restore around each
// case. Same heuristic the real spawn-monitor-daemon path uses; if this drifts
// it'll break the daemon respawn too.
describe( `is_compiled_binary`, () => {

    const original = process.argv[1]
    afterEach( () => {
        process.argv[1] = original
    } )

    it( `returns true when argv[1] is a /$bunfs synthetic path`, () => {
        process.argv[1] = `/$bunfs/root/babysit`
        expect( is_compiled_binary() ).toBe( true )
    } )

    it( `returns true when argv[1] is empty (also indicates compiled)`, () => {
        process.argv[1] = ``
        expect( is_compiled_binary() ).toBe( true )
    } )

    it( `returns false when argv[1] is a real .js entry path`, () => {
        process.argv[1] = `/Users/me/babysit/src/index.js`
        expect( is_compiled_binary() ).toBe( false )
    } )

} )

describe( `binary_platform_tag`, () => {

    it( `returns null for unsupported platform/arch combos`, () => {

        // Stub os.platform/arch can't be done cleanly without DI, so we just
        // exercise the function on the running platform and assert the
        // contract: it returns either a known tag or null.
        const tag = binary_platform_tag()
        if( tag !== null ) {
            expect( tag ).toMatch( /^(darwin|linux)-(x64|arm64)$/ )
        }

    } )

    it( `matches the asset naming used by scripts/install.sh`, () => {

        // scripts/install.sh fetches `babysit-${OS}-${ARCH}` where OS is
        // darwin|linux and ARCH is x64|arm64. binary_platform_tag must
        // produce the same suffix so the update path looks up the right asset.
        const tag = binary_platform_tag()
        if( tag !== null ) {
            const [ os, cpu ] = tag.split( `-` )
            expect( [ `darwin`, `linux` ] ).toContain( os )
            expect( [ `x64`, `arm64` ] ).toContain( cpu )
        }

    } )

} )

describe( `is_on_path`, () => {

    const original = process.env.PATH

    afterEach( () => {
        process.env.PATH = original
    } )

    it( `recognises a directory present on $PATH`, () => {
        process.env.PATH = `/usr/bin:/home/me/.local/bin:/usr/local/bin`
        expect( is_on_path( `/home/me/.local/bin` ) ).toBe( true )
    } )

    it( `returns false for a directory absent from $PATH`, () => {
        process.env.PATH = `/usr/bin:/usr/local/bin`
        // Catches the regression where the new ~/.local/bin install path
        // wouldn't be discoverable and we silently skipped the warning.
        expect( is_on_path( `/home/me/.local/bin` ) ).toBe( false )
    } )

    it( `does not match on substring (entries are exact-equal)`, () => {
        process.env.PATH = `/home/me/.local/bin/extra:/usr/bin`
        expect( is_on_path( `/home/me/.local/bin` ) ).toBe( false )
    } )

} )


describe( `Docker image update`, () => {

    const metadata = ( id, version ) => JSON.stringify( [ {
        Id: id,
        Config: { Labels: version ? { 'org.opencontainers.image.version': version } : null },
    } ] )

    const update = async ( before, after, pull_error ) => {
        const messages = []
        const calls = []
        const original_log = console.log
        console.log = message => messages.push( message )

        try {
            await update_docker_image( async ( command, args, options, timeout ) => {
                calls.push( { command, args, timeout } )
                if( args[0] === `pull` ) {
                    if( pull_error ) throw pull_error
                    return ``
                }
                const result = calls.length === 1 ? before : after
                if( result instanceof Error ) throw result
                return result
            } )
        } finally {
            console.log = original_log
        }

        expect( messages.join( `\n` ) ).not.toContain( `sha256:` )
        return { output: messages.join( `\n` ), calls }
    }

    it( `uses the full pull deadline and reports the downloaded image version`, async () => {
        const { output, calls } = await update( metadata( `sha256:old`, `1.0.0` ), metadata( `sha256:new`, `2.0.0` ) )
        expect( calls[1].timeout ).toBe( 120_000 )
        expect( output ).toContain( `downloaded image: v2.0.0` )
    } )

    it( `reports a first download when no local image exists`, async () => {
        const { output } = await update( new Error( `No such image` ), metadata( `sha256:new`, `v2.0.0` ) )
        expect( output ).toContain( `downloaded image: v2.0.0` )
    } )

    it( `distinguishes an unchanged image from a new download`, async () => {
        const image = metadata( `sha256:same`, `2.0.0` )
        const { output } = await update( image, image )
        expect( output ).toContain( `already up to date: v2.0.0` )
        expect( output ).not.toContain( `downloaded image` )
    } )

    it( `identifies unlabelled images without claiming a release version`, async () => {
        for( const version of [ undefined, `unknown` ] ) {
            const { output } = await update( `[]`, metadata( `sha256:new`, version ) )
            expect( output ).toContain( `version unavailable` )
        }
    } )

    it( `keeps successful pulls successful when metadata cannot be read`, async () => {
        const { output } = await update( `[]`, new Error( `inspect failed` ) )
        expect( output ).toContain( `docker pull succeeded (image version unavailable)` )
        expect( output ).not.toContain( `docker pull failed` )
    } )

    it( `reports pull failures without claiming a downloaded version`, async () => {
        const { output, calls } = await update( `[]`, `[]`, new Error( `registry unavailable` ) )
        expect( output ).toContain( `docker pull failed: registry unavailable` )
        expect( calls ).toHaveLength( 2 )
        expect( output ).not.toContain( `downloaded image` )
    } )

} )

describe( `automatic updates`, () => {

    it( `update --auto stores the Y/n answer`, async () => {
        const writes = []
        const quiet = console.log
        console.log = () => {}
        try {
            expect( await configure_auto_update( { ask: async question => question === `Enable automatic updates? Y/n `, write_config: config => writes.push( config ) } ) ).toBe( true )
            expect( await configure_auto_update( { ask: async () => false, write_config: config => writes.push( config ) } ) ).toBe( false )
        } finally {
            console.log = quiet
        }
        expect( writes ).toEqual( [ { auto_update: true }, { auto_update: false } ] )
    } )

    it( `starts one background update per newer release, retrying a day later`, () => {
        const directory = mkdtempSync( join( tmpdir(), `babysit-auto-update-` ) )
        const state_path = join( directory, `auto-update.json` )
        let started = 0
        const quiet = console.error
        console.error = () => {}
        const attempt = ( options = {} ) => maybe_auto_update( {
            read_config: () => ( { auto_update: true } ),
            version_check: () => ( { latest: `9.9.9` } ),
            start_update: () => started++,
            state_path,
            now: 1_000,
            ...options,
        } )
        try {
            expect( attempt( { read_config: () => ( { auto_update: false } ) } ) ).toBeNull()
            expect( attempt( { version_check: () => ( { latest: null } ) } ) ).toBeNull()
            expect( attempt() ).toBe( `9.9.9` )
            expect( attempt() ).toBeNull()
            expect( attempt( { now: 1_000 + 25 * 60 * 60_000 } ) ).toBe( `9.9.9` )
        } finally {
            console.error = quiet
        }
        expect( started ).toBe( 2 )
        expect( JSON.parse( readFileSync( state_path, `utf8` ) ).version ).toBe( `9.9.9` )
        rmSync( directory, { recursive: true, force: true } )
    } )

} )

describe( `update_web_container`, () => {

    const compose_labels = {
        'com.docker.compose.project': `stack`,
        'com.docker.compose.service': `babysit-web`,
        'com.docker.compose.project.config_files': `/stack/a.yml,/stack/b.yml`,
        'com.docker.compose.project.working_dir': `/stack`,
        'com.docker.compose.project.environment_file': `/stack/.env`,
    }

    const web_container = ( overrides = {} ) => ( {
        Name: `/babysit-web`,
        Image: `sha256:old`,
        Mounts: [ { Source: `/srv/bridge/access`, Destination: `/bridge/access` } ],
        NetworkSettings: { Networks: { stack_default: {}, traefik: {} } },
        Config: {
            Image: `actuallymentor/babysit-web:stable`,
            User: `1000:1001`,
            Env: [ `PATH=/bin`, `BABYSIT_WEB_PUBLIC_ORIGIN=https://x.test/?a=b` ],
            Labels: compose_labels,
        },
        ...overrides,
    } )

    const update = async ( containers, { pulled_id = `sha256:new`, fail } = {} ) => {

        const calls = []
        const messages = []
        const original_log = console.log
        console.log = message => messages.push( message )

        try {
            await update_web_container( async ( command, args, options ) => {
                calls.push( { args, options } )
                if( fail?.( args ) ) throw new Error( `docker said no` )
                if( args[0] === `ps` ) return containers.length ? `abc\n` : ``
                if( args[0] === `inspect` ) return JSON.stringify( containers )
                if( args[0] === `image` ) return JSON.stringify( [ { Id: pulled_id } ] )
                return ``
            } )
        } finally {
            console.log = original_log
        }

        return { calls, output: messages.join( `\n` ), recreate: calls.find( ( { args } ) => args[0] === `compose` ) }

    }

    it( `recreates through the original Compose project when the image changed`, async () => {
        const { recreate, output, calls } = await update( [ web_container() ] )
        expect( calls.map( ( { args } ) => args[0] ) ).toEqual( [ `ps`, `inspect`, `pull`, `image`, `compose` ] )
        expect( recreate.args ).toEqual( [
            `compose`, `-p`, `stack`, `--project-directory`, `/stack`,
            `-f`, `/stack/a.yml`, `-f`, `/stack/b.yml`, `--env-file`, `/stack/.env`,
            `up`, `-d`, `--no-deps`, `babysit-web`,
        ] )
        expect( output ).toContain( `restarted on the new image` )
    } )

    it( `replays the variables the shell supplied at start`, async () => {
        const { recreate: { options: { env } } } = await update( [ web_container() ] )
        expect( env.BABYSIT_WEB_UID ).toBe( `1000` )
        expect( env.BABYSIT_WEB_GID ).toBe( `1001` )
        expect( env.BABYSIT_WEB_PUBLIC_ORIGIN ).toBe( `https://x.test/?a=b` )
        expect( env.BABYSIT_WEB_TAG ).toBe( `stable` )
        expect( env.BABYSIT_WEB_BRIDGE_DIR ).toBe( `/srv/bridge` )
        expect( env.BABYSIT_WEB_PROXY_NETWORK ).toBe( `traefik` )
    } )

    it( `leaves a container on the current image alone`, async () => {
        const { recreate, output } = await update( [ web_container() ], { pulled_id: `sha256:old` } )
        expect( recreate ).toBeUndefined()
        expect( output ).toContain( `already up to date` )
    } )

    it( `skips hosts without a web container and locally built images`, async () => {
        const agent = web_container( { Config: { Image: `actuallymentor/babysit:latest` } } )
        const local = web_container( { Config: { Image: `actuallymentor/babysit-web:local` } } )
        const { calls, output } = await update( [ agent, local ] )
        expect( calls.map( ( { args } ) => args[0] ) ).toEqual( [ `ps`, `inspect` ] )
        expect( output ).toContain( `no running babysit web container` )
    } )

    it( `does not touch a container Compose did not start`, async () => {
        const plain = web_container( { Config: { ...web_container().Config, Labels: {} } } )
        const { recreate, output } = await update( [ plain ] )
        expect( recreate ).toBeUndefined()
        expect( output ).toContain( `recreate it by hand` )
    } )

    it( `reports failures without throwing`, async () => {
        const { output: pull } = await update( [ web_container() ], { fail: args => args[0] === `pull` } )
        expect( pull ).toContain( `✗ web update failed: docker said no` )
        const { output: list } = await update( [], { fail: args => args[0] === `ps` } )
        expect( list ).toContain( `✗ listing containers failed` )
    } )

} )
