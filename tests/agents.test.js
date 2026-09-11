import { describe, it, expect } from 'bun:test'
import { get_agent, SUPPORTED_AGENTS, is_agent } from '../src/agents/index.js'
import { extract_session_id } from '../src/sessions/extract.js'

describe( `agent registry`, () => {

    it( `supports four agents`, () => {
        expect( SUPPORTED_AGENTS ).toEqual( [ `claude`, `codex`, `antigravity`, `opencode` ] )
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

    it( `captures Antigravity resume ids`, () => {
        const antigravity = get_agent( `antigravity` )
        expect( extract_session_id( `agy --conversation ${ uuid }`, antigravity.session_id_pattern ) ).toBe( uuid )
        expect( extract_session_id( `Conversation ID: ${ uuid }`, antigravity.session_id_pattern ) ).toBe( uuid )
    } )

    it( `captures OpenCode ses_ ids`, () => {
        const opencode = get_agent( `opencode` )
        const opencode_id = `ses_66a71b6f4ffeq796jvvOpJQ04m`

        expect( extract_session_id( `opencode --session ${ opencode_id }`, opencode.session_id_pattern ) ).toBe( opencode_id )
        expect( extract_session_id( `Session ID: ${ opencode_id }`, opencode.session_id_pattern ) ).toBe( opencode_id )
    } )

} )

describe( `agent adapter shape`, () => {

    for( const name of SUPPORTED_AGENTS ) {

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
    // Codex OAuth and OpenCode on Darwin before the fix.

    const claude = get_agent( `claude` )
    const codex = get_agent( `codex` )
    const antigravity = get_agent( `antigravity` )
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

    it( `antigravity declares the OAuth creds file in addition to GEMINI_API_KEY`, () => {
        expect( antigravity.credentials.darwin.fallback_file ).toBe( `~/.gemini/antigravity-cli/antigravity-oauth-token` )
        expect( antigravity.credentials.linux.file ).toBe( `~/.gemini/antigravity-cli/antigravity-oauth-token` )
        expect( antigravity.credentials.darwin.env_key ).toBe( `GEMINI_API_KEY` )
    } )

    it( `opencode declares its file path on darwin (no Keychain — opencode does not use it)`, () => {
        // opencode stores tokens in a plain file even on macOS. Pre-fix, darwin
        // adapter only handled keychain_service + fallback_file, so opencode's
        // creds were silently skipped.
        expect( opencode.credentials.darwin.file ).toBe( `~/.local/share/opencode/auth.json` )
        expect( opencode.credentials.linux.file ).toBe( `~/.local/share/opencode/auth.json` )
    } )

    it( `each agent declares a container target for its credential file`, () => {
        // The darwin/linux setup_credentials code stages the host tmpfile at
        // agent.container_paths.creds — null targets silently drop the file.
        expect( claude.container_paths.creds ).toBe( `/home/node/.claude/.credentials.json` )
        expect( codex.container_paths.creds ).toBe( `/home/node/.codex/auth.json` )
        expect( antigravity.container_paths.creds ).toBe( `/home/node/.gemini/antigravity-cli/antigravity-oauth-token` )
        expect( opencode.container_paths.creds ).toBe( `/home/node/.local/share/opencode/auth.json` )
    } )

    it( `each credential mount target is an absolute container path`, () => {
        // Targets must be absolute and container-local — relative paths confuse
        // docker's bind-mount, and host paths would point at user files.
        for( const a of [ claude, codex, antigravity, opencode ] ) {
            expect( a.container_paths.creds.startsWith( `/home/node/` ) ).toBe( true )
        }
    } )

} )

describe( `credential preflight`, () => {

    it( `is declared only by Claude`, () => {
        const preflight_agents = SUPPORTED_AGENTS.filter(
            name => get_agent( name ).credential_preflight
        )

        expect( preflight_agents ).toEqual( [ `claude` ] )
    } )

} )

describe( `model defaults`, () => {

    // OpenCode resolves a current model against the authenticated provider.
    // Antigravity remains unpinned so its own account router can choose.

    it( `opencode resolves the frontier model through the authenticated provider`, () => {
        const resolve_model = get_agent( `opencode` ).defaults.model

        expect( typeof resolve_model ).toBe( `function` )
        expect( resolve_model( {
            route: {},
            path_exists: () => true,
            read_file: () => JSON.stringify( {
                openrouter: { type: `api`, key: `redacted` },
            } ),
        } ) ).toBe( `openrouter/openai/gpt-5.6-sol` )
    } )

    it( `antigravity does not force a model`, () => {
        expect( get_agent( `antigravity` ).defaults.model ).toBeUndefined()
    } )

    it( `claude and codex force their preferred frontier defaults`, () => {
        expect( get_agent( `claude` ).defaults.model ).toBe( `best` )
        expect( get_agent( `claude` ).defaults.effort ).toBe( `xhigh` )
        expect( get_agent( `codex` ).defaults.model ).toBe( `gpt-6-astra` )
        expect( get_agent( `codex` ).defaults.effort ).toBe( `medium` )
    } )

} )

describe( `Antigravity CLI flags`, () => {

    const agent = get_agent( `antigravity` )

    it( `uses the native binary and permissions flag`, () => {
        expect( agent.bin ).toBe( `agy` )
        expect( agent.flags.skip_permissions() ).toBe( `--dangerously-skip-permissions` )
    } )

    it( `resumes an exact conversation or the latest conversation`, () => {
        expect( agent.flags.resume( `conversation-id` ) ).toEqual( [ `--conversation`, `conversation-id` ] )
        expect( agent.flags.resume_latest() ).toEqual( [ `--continue` ] )
    } )

    it( `exposes native effort and headless prompt flags`, () => {
        expect( agent.flags.effort( `high` ) ).toEqual( [ `--effort`, `high` ] )
        expect( agent.auth_check.args( `Say ok` ) ).toEqual( [ `--print`, `Say ok` ] )
    } )

    it( `waits for the Antigravity composer instead of typing into native setup`, () => {
        expect( agent.initial_prompt_ready( `Antigravity CLI 1.2.1\n>\n────\n? for shortcuts     Gemini 3.8 Flash · medium` ) ).toBe( true )
        for( const screen of [
            `Do you trust the contents of this project?\n> Yes, I trust this folder\n↑/↓ Navigate · enter Confirm`,
            `Choose your color scheme:\n> terminal\n↑/↓ Navigate · enter Confirm`,
            `Select login method:\n> Google account\n↑/↓ Navigate · enter Select`,
            `Terms of Service & Data Use\n> [ ] Yes, I agree\n↑/↓ Navigate · enter Toggle`,
            `⣯ Generating...\n>\nesc to cancel       Gemini 3.8 Flash · medium`,
        ] ) expect( agent.initial_prompt_ready( screen ) ).toBe( false )
    } )

    it( `does not reinterpret old Gemini sessions as Antigravity`, () => {
        expect( get_agent( `gemini` ) ).toBeNull()
        expect( is_agent( `gemini` ) ).toBe( false )
    } )

} )
