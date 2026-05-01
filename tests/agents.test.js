import { describe, it, expect } from 'bun:test'
import { get_agent, SUPPORTED_AGENTS, is_agent } from '../src/agents/index.js'

describe( `agent registry`, () => {

    it( `supports four agents`, () => {
        expect( SUPPORTED_AGENTS ).toEqual( [ `claude`, `codex`, `gemini`, `opencode` ] )
    } )

    it( `returns null for unknown agent`, () => {
        expect( get_agent( `unknown` ) ).toBeNull()
    } )

    it( `identifies known agents`, () => {
        expect( is_agent( `claude` ) ).toBe( true )
        expect( is_agent( `invalid` ) ).toBe( false )
    } )

} )

describe( `agent adapter shape`, () => {

    for ( const name of SUPPORTED_AGENTS ) {

        describe( name, () => {

            const agent = get_agent( name )

            it( `has required fields`, () => {
                expect( agent.name ).toBe( name )
                expect( typeof agent.bin ).toBe( `string` )
                expect( agent.credentials ).toBeDefined()
                expect( agent.flags ).toBeDefined()
                expect( agent.session_id_pattern ).toBeInstanceOf( RegExp )
            } )

            it( `has skip_permissions flag`, () => {
                expect( typeof agent.flags.skip_permissions ).toBe( `function` )
            } )

            it( `has extra_env function`, () => {
                expect( typeof agent.extra_env ).toBe( `function` )
                expect( typeof agent.extra_env() ).toBe( `object` )
            } )

            it( `has credentials for both platforms`, () => {
                expect( agent.credentials.darwin ).toBeDefined()
                expect( agent.credentials.linux ).toBeDefined()
            } )

        } )

    }

} )

describe( `credential coverage`, () => {

    // Each adapter must expose a credential source the platform layer can load.
    // Symptom of forgetting this: babysit launches the agent in the container
    // unauthenticated even though the user logged in on the host. Was true for
    // codex/gemini OAuth and for opencode-on-darwin before the fix.

    const codex = get_agent( `codex` )
    const gemini = get_agent( `gemini` )
    const opencode = get_agent( `opencode` )

    it( `codex declares the OAuth auth.json file in addition to env keys`, () => {
        // codex auth login writes to ~/.codex/auth.json — without this declared,
        // OAuth-authed users would get no creds passed through.
        expect( codex.credentials.darwin.file ).toBe( `~/.codex/auth.json` )
        expect( codex.credentials.linux.file ).toBe( `~/.codex/auth.json` )
        // env-key fallback for API-key users stays available
        expect( codex.credentials.darwin.env_key ).toBe( `CODEX_API_KEY` )
    } )

    it( `gemini declares the OAuth creds file in addition to GEMINI_API_KEY`, () => {
        expect( gemini.credentials.darwin.file ).toBe( `~/.gemini/oauth_creds.json` )
        expect( gemini.credentials.linux.file ).toBe( `~/.gemini/oauth_creds.json` )
        expect( gemini.credentials.darwin.env_key ).toBe( `GEMINI_API_KEY` )
    } )

    it( `opencode declares its file path on darwin (no Keychain — opencode does not use it)`, () => {
        // opencode stores tokens in a plain file even on macOS. Pre-fix, darwin
        // adapter only handled keychain_service + fallback_file, so opencode's
        // creds were silently skipped.
        expect( opencode.credentials.darwin.file ).toBe( `~/.local/share/opencode/auth.json` )
        expect( opencode.credentials.linux.file ).toBe( `~/.local/share/opencode/auth.json` )
    } )

    it( `each agent declares a container target for its credential file`, () => {
        // The darwin/linux setup_credentials code mounts the host tmpfile to
        // agent.container_paths.creds — null targets silently drop the mount.
        expect( codex.container_paths.creds ).toBe( `/home/node/.codex/auth.json` )
        expect( gemini.container_paths.creds ).toBe( `/home/node/.gemini/oauth_creds.json` )
        expect( opencode.container_paths.creds ).toBe( `/home/node/.local/share/opencode/auth.json` )
    } )

    it( `each credential mount target is an absolute container path`, () => {
        // Targets must be absolute and container-local — relative paths confuse
        // docker's bind-mount, and host paths would point at user files.
        for ( const a of [ codex, gemini, opencode ] ) {
            expect( a.container_paths.creds.startsWith( `/home/node/` ) ).toBe( true )
        }
    } )

} )

describe( `model defaults`, () => {

    // Wrong defaults silently break sessions for the most common auth path:
    //   - opencode default `gpt-5.5-pro` is rejected by ChatGPT-account auth
    //     ("model not supported when using Codex with a ChatGPT account") —
    //     the ChatGPT subscription is the most common opencode auth path,
    //     so the safer default is `openai/gpt-5.5` which works for both
    //     OAuth and API-key flows.
    //   - gemini's `gemini-pro-latest` 404s for users on Gemini Code Assist
    //     for Individuals (the free tier — Pro routing was restricted to
    //     paid plans). Empty defaults let gemini's internal agent router
    //     pick whatever the user's plan supports.

    it( `opencode pins openai/gpt-5.5 (works for both OAuth and API-key auth)`, () => {
        expect( get_agent( `opencode` ).defaults.model ).toBe( `openai/gpt-5.5` )
    } )

    it( `gemini does NOT force a model (would break free-tier users)`, () => {
        expect( get_agent( `gemini` ).defaults.model ).toBeUndefined()
    } )

    it( `claude and codex still force their max-effort models`, () => {
        expect( get_agent( `claude` ).defaults.model ).toBe( `opus` )
        expect( get_agent( `claude` ).defaults.effort ).toBe( `max` )
        expect( get_agent( `codex` ).defaults.model ).toBe( `gpt-5.5` )
        expect( get_agent( `codex` ).defaults.effort ).toBe( `high` )
    } )

} )

describe( `gemini extra_args`, () => {

    // gemini --skip-trust is a one-shot session override that bypasses the
    // trustedFolders.json file. We only want it under --yolo, where the user
    // has explicitly said "trust this run, no questions". Outside yolo,
    // the trustedFolders.json mount is the source of truth — passing
    // --skip-trust there would override an intentional non-trust setting.

    const gemini = get_agent( `gemini` )

    it( `passes --skip-trust under --yolo`, () => {
        expect( gemini.extra_args( { yolo: true } ) ).toEqual( [ `--skip-trust` ] )
    } )

    it( `does not pass --skip-trust outside --yolo`, () => {
        expect( gemini.extra_args( { yolo: false } ) ).toEqual( [] )
        expect( gemini.extra_args( {} ) ).toEqual( [] )
    } )

} )
