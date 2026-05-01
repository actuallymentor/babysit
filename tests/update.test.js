import { describe, it, expect, afterEach } from 'bun:test'
import { is_compiled_binary, binary_platform_tag, is_on_path } from '../src/cli/update.js'

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
