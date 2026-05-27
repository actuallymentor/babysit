import { describe, it, expect } from 'bun:test'
import { get_agent, SUPPORTED_AGENTS, is_agent } from '../src/agents/index.js'
import { extract_session_id } from '../src/sessions/extract.js'

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

describe( `agent session id capture`, () => {

    const uuid = `019df81b-ce45-70f0-ab6e-3cbd64c83397`

    it( `captures Claude status and resume-hint ids`, () => {
        const claude = get_agent( `claude` )
        expect( extract_session_id( `Session ID: ${ uuid }`, claude.session_id_pattern ) ).toBe( uuid )
        expect( extract_session_id( `To continue, run claude --resume ${ uuid }`, claude.session_id_pattern ) ).toBe( uuid )
    } )

    it( `captures Codex resume hints`, () => {
        const codex = get_agent( `codex` )
        expect( extract_session_id( `To continue this session, run codex resume ${ uuid }`, codex.session_id_pattern ) ).toBe( uuid )
        expect( extract_session_id( `Session ID: ${ uuid }`, codex.session_id_pattern ) ).toBe( uuid )
    } )

    it( `captures Gemini resume ids`, () => {
        const gemini = get_agent( `gemini` )
        expect( extract_session_id( `gemini --resume ${ uuid }`, gemini.session_id_pattern ) ).toBe( uuid )
        expect( extract_session_id( `session: ${ uuid }`, gemini.session_id_pattern ) ).toBe( uuid )
    } )

    it( `captures OpenCode ses_ ids`, () => {
        const opencode = get_agent( `opencode` )
        const opencode_id = `ses_66a71b6f4ffeq796jvvOpJQ04m`

        expect( extract_session_id( `opencode --session ${ opencode_id }`, opencode.session_id_pattern ) ).toBe( opencode_id )
        expect( extract_session_id( `Session ID: ${ opencode_id }`, opencode.session_id_pattern ) ).toBe( opencode_id )
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

    const claude = get_agent( `claude` )
    const codex = get_agent( `codex` )
    const gemini = get_agent( `gemini` )
    const opencode = get_agent( `opencode` )

    it( `codex resolves the OAuth auth.json file from host CODEX_HOME`, () => {
        // codex login writes to `${CODEX_HOME}/auth.json` when CODEX_HOME is
        // set. Hardcoding ~/.codex/auth.json silently mounts stale creds for
        // users who keep Codex state somewhere else.
        const original_codex_home = process.env.CODEX_HOME

        try {

            delete process.env.CODEX_HOME
            expect( codex.credentials.darwin.file() ).toBe( `~/.codex/auth.json` )
            expect( codex.credentials.linux.file() ).toBe( `~/.codex/auth.json` )

            process.env.CODEX_HOME = `/tmp/host-codex-home/`
            expect( codex.credentials.darwin.file() ).toBe( `/tmp/host-codex-home/auth.json` )
            expect( codex.credentials.linux.file() ).toBe( `/tmp/host-codex-home/auth.json` )

        } finally {
            if( original_codex_home === undefined ) delete process.env.CODEX_HOME
            else process.env.CODEX_HOME = original_codex_home
        }

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
        expect( claude.container_paths.creds ).toBe( `/home/node/.claude/.credentials.json` )
        expect( codex.container_paths.creds ).toBe( `/home/node/.codex/auth.json` )
        expect( gemini.container_paths.creds ).toBe( `/home/node/.gemini/oauth_creds.json` )
        expect( opencode.container_paths.creds ).toBe( `/home/node/.local/share/opencode/auth.json` )
    } )

    it( `each credential mount target is an absolute container path`, () => {
        // Targets must be absolute and container-local — relative paths confuse
        // docker's bind-mount, and host paths would point at user files.
        for ( const a of [ claude, codex, gemini, opencode ] ) {
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
        expect( get_agent( `codex` ).defaults.effort ).toBe( `xhigh` )
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
