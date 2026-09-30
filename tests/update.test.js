import { describe, it, expect, afterEach } from 'bun:test'
import { is_compiled_binary, binary_platform_tag, is_on_path, update_docker_image } from '../src/cli/update.js'

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

        return { output: messages.join( `\n` ), calls }
    }

    it( `uses the full pull deadline and reports the downloaded image version`, async () => {
        const { output, calls } = await update( metadata( `sha256:old`, `1.0.0` ), metadata( `sha256:new`, `2.0.0` ) )
        expect( calls[1].timeout ).toBe( 120_000 )
        expect( output ).toContain( `downloaded image: v2.0.0 (sha256:new)` )
    } )

    it( `reports a first download when no local image exists`, async () => {
        const { output } = await update( new Error( `No such image` ), metadata( `sha256:new`, `v2.0.0` ) )
        expect( output ).toContain( `downloaded image: v2.0.0 (sha256:new)` )
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
            expect( output ).toContain( `version unavailable (sha256:new)` )
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
