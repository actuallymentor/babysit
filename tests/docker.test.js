import { describe, it, expect } from 'bun:test'
import { get_image_name } from '../src/docker/update.js'
import { build_docker_command } from '../src/docker/run.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { gemini } from '../src/agents/gemini.js'
import { opencode } from '../src/agents/opencode.js'

const make_options = ( overrides = {} ) => ( {
    agent: codex,
    workspace: `/tmp/empty`,
    mode: { yolo: true },
    system_prompt: ``,
    agent_args: [],
    creds_mounts: [],
    config: { isolate_dependencies: false },
    extra_env: {},
    modifiers: [ `yolo` ],
    ...overrides,
} )

describe( `docker image`, () => {

    it( `points at the published image (actuallymentor/babysit)`, () => {

        // The publish workflow tags as actuallymentor/babysit — if these drift,
        // `docker pull` and `docker run` will both fail at runtime
        expect( get_image_name() ).toBe( `actuallymentor/babysit:latest` )
        expect( get_image_name( `0.3.0` ) ).toBe( `actuallymentor/babysit:0.3.0` )

    } )

} )

describe( `codex adapter`, () => {

    it( `resumes interactively (no exec subcommand)`, () => {
        // codex exec resume launches non-interactive mode, which can't be supervised
        // through tmux — must be the bare `resume` subcommand
        const args = codex.flags.resume( `abc-123` )
        expect( args ).toEqual( [ `resume`, `abc-123` ] )
        expect( args ).not.toContain( `exec` )
    } )

    it( `injects reasoning effort via -c model_reasoning_effort override`, () => {
        // The bare `reasoning_effort` key is silently ignored by codex; the real
        // config knob is `model_reasoning_effort`. Quote the value so it survives
        // YAML/TOML parsing inside codex's -c handler.
        expect( codex.flags.effort( `high` ) ).toEqual( [ `-c`, `model_reasoning_effort="high"` ] )
    } )

    it( `defaults to the latest GA model at high effort`, () => {
        expect( codex.defaults.model ).toBe( `gpt-5.5` )
        expect( codex.defaults.effort ).toBe( `high` )
    } )

    it( `skip_permissions bypasses both approvals and the internal sandbox`, () => {
        // We already wrap codex in our own docker sandbox; --full-auto would leave
        // codex's internal sandbox active and block edits inside babysit --yolo.
        expect( codex.flags.skip_permissions() ).toBe( `--dangerously-bypass-approvals-and-sandbox` )
    } )

} )

describe( `system-prompt-file hint`, () => {

    // Targets must be container-local — /workspace is read-only in mudbox mode
    // and ephemeral in sandbox mode, so writing the system prompt there silently
    // fails for those modes.

    it( `codex uses ~/.codex/instructions.md (writable in every mode)`, () => {
        expect( codex.container_paths.system_prompt_file ).toBe( `/home/node/.codex/instructions.md` )
        expect( codex.container_paths.system_prompt_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `gemini uses ~/.gemini/GEMINI.md`, () => {
        expect( gemini.container_paths.system_prompt_file ).toBe( `/home/node/.gemini/GEMINI.md` )
        expect( gemini.container_paths.system_prompt_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `opencode uses ~/.config/opencode/AGENTS.md`, () => {
        expect( opencode.container_paths.system_prompt_file ).toBe( `/home/node/.config/opencode/AGENTS.md` )
        expect( opencode.container_paths.system_prompt_file ).not.toMatch( /^\/workspace/ )
    } )

} )

describe( `build_docker_command`, () => {

    it( `single-quotes claude's --append-system-prompt value with spaces`, () => {

        // Without quoting, the prompt would be split on spaces by sh -c
        const cmd = build_docker_command( make_options( {
            agent: claude,
            system_prompt: `You are running. Be helpful.`,
        } ) )

        expect( cmd ).toContain( `--append-system-prompt 'You are running. Be helpful.'` )

    } )

    it( `escapes embedded single quotes in shell values`, () => {

        const cmd = build_docker_command( make_options( {
            agent: claude,
            system_prompt: `it's complicated`,
        } ) )

        // 'foo'\''bar' is the POSIX way to embed a single quote in a single-quoted string
        expect( cmd ).toContain( `'it'\\''s complicated'` )

    } )

    it( `does not expand $-variables in env values`, () => {

        // System prompt with $ should be passed literally, not expanded by sh
        const cmd = build_docker_command( make_options( {
            agent: codex,
            system_prompt: `Use $HOME wisely`,
        } ) )

        expect( cmd ).toContain( `'BABYSIT_SYSTEM_PROMPT=Use $HOME wisely'` )

    } )

    it( `injects BABYSIT_SYSTEM_PROMPT_FILE for non-claude agents`, () => {

        const cmd = build_docker_command( make_options( {
            agent: gemini,
            system_prompt: `hello`,
        } ) )

        expect( cmd ).toContain( `BABYSIT_SYSTEM_PROMPT_FILE=/home/node/.gemini/GEMINI.md` )

    } )

    it( `omits BABYSIT_SYSTEM_PROMPT_FILE for claude (uses CLI flag instead)`, () => {

        const cmd = build_docker_command( make_options( {
            agent: claude,
            system_prompt: `hello`,
        } ) )

        expect( cmd ).not.toContain( `BABYSIT_SYSTEM_PROMPT_FILE` )

    } )

    it( `auto-applies max-effort and latest-model defaults`, () => {

        const cmd = build_docker_command( make_options( { agent: codex } ) )

        // Spec: "always auto-selects the maximum effort and latest model"
        expect( cmd ).toContain( `--model gpt-5.5` )
        // model_reasoning_effort is the real codex config key (not reasoning_effort).
        // The full-quoted form is shell_quote'd into a single arg by build_docker_command.
        expect( cmd ).toContain( `'model_reasoning_effort="high"'` )

    } )

} )
