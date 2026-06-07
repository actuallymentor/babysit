import { describe, it, expect } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { get_image_name } from '../src/docker/update.js'
import { build_agent_state_volume_name, build_docker_command, get_agent_state_mounts, prepare_nested_file_mountpoint, resolve_workspace_mount_source, should_mount_user_globals } from '../src/docker/run.js'
import { claude } from '../src/agents/claude.js'
import { codex } from '../src/agents/codex.js'
import { gemini } from '../src/agents/gemini.js'
import { opencode } from '../src/agents/opencode.js'

const make_options = ( overrides = {} ) => ( {
    agent: codex,
    workspace: `/tmp/empty`,
    mode: { yolo: true },
    agent_args: [],
    creds_mounts: [],
    config: { isolate_dependencies: false },
    extra_env: {},
    modifiers: [ `yolo` ],
    ...overrides,
} )

const with_env = async ( values, fn ) => {

    const previous = Object.fromEntries(
        Object.keys( values ).map( key => [ key, process.env[ key ] ] )
    )

    try {
        for ( const [ key, value ] of Object.entries( values ) ) {
            if( value === undefined ) delete process.env[ key ]
            else process.env[ key ] = value
        }

        return await fn()
    } finally {
        for ( const [ key, value ] of Object.entries( previous ) ) {
            if( value === undefined ) delete process.env[ key ]
            else process.env[ key ] = value
        }
    }

}

describe( `docker image`, () => {

    it( `points at the published image (actuallymentor/babysit)`, () => {

        // The publish workflow tags as actuallymentor/babysit — if these drift,
        // `docker pull` and `docker run` will both fail at runtime
        expect( get_image_name() ).toBe( `actuallymentor/babysit:latest` )
        expect( get_image_name( `0.3.0` ) ).toBe( `actuallymentor/babysit:0.3.0` )

    } )

    it( `can be overridden for local E2E images`, async () => {
        await with_env( { BABYSIT_DOCKER_IMAGE: `babysit:e2e-fake` }, () => {
            expect( get_image_name() ).toBe( `babysit:e2e-fake` )
            expect( get_image_name( `0.3.0` ) ).toBe( `babysit:e2e-fake` )
        } )
    } )

    it( `installs ripgrep through apt instead of an arch-guessed GitHub .deb`, () => {

        // BurntSushi/ripgrep publishes .deb release assets for amd64 only.
        // Debian's package is available for both amd64 and arm64, which keeps
        // local Apple Silicon builds and multi-arch published images aligned.
        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        expect( dockerfile ).toContain( `shellcheck sqlite3 tree ripgrep` )
        expect( dockerfile ).not.toContain( `ripgrep_\${` )
        expect( dockerfile ).not.toContain( `/tmp/rg.deb` )

    } )

    it( `fails the image build instead of masking install failures`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        expect( dockerfile ).toContain( `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` )
        expect( dockerfile ).not.toContain( `|| true` )
        expect( dockerfile ).not.toContain( `2>/dev/null` )

    } )

    it( `verifies expected container tools are on PATH`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        for ( const cmd of [ `rg`, `fd`, `bat`, `fzf`, `yq`, `scc`, `uv`, `uvx`, `bun`, `pnpm`, `yarn`, `pipx`, `just`, `docker`, `codex`, `gemini`, `claude`, `opencode` ] ) {
            expect( dockerfile ).toContain( ` ${ cmd }` )
        }
        expect( dockerfile ).toContain( `command -v "$cmd"` )
        expect( dockerfile ).toContain( `docker compose version` )
        expect( dockerfile ).toContain( `docker buildx version` )

    } )

    it( `installs Docker CLI packages without installing the daemon`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        expect( dockerfile ).toContain( `download.docker.com/linux/debian` )
        expect( dockerfile ).toContain( `docker-ce-cli docker-buildx-plugin docker-compose-plugin` )
        expect( dockerfile ).not.toContain( `apt-get install -y --no-install-recommends docker-ce ` )
        expect( dockerfile ).not.toContain( `containerd.io` )

    } )

    it( `installs just outside apt so slim-base package availability cannot break builds`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )
        const [ apt_install_block ] = dockerfile.match( /RUN apt-get update && apt-get install[\s\S]*?&& rm -rf \/var\/lib\/apt\/lists\/\*/ )

        expect( apt_install_block ).not.toMatch( /\bjust\b/ )
        expect( dockerfile ).toContain( `JUST_VERSION=` )
        expect( dockerfile ).toContain( `just-\${JUST_VERSION}-\${JUST_ARCH}-unknown-linux-musl.tar.gz` )
        expect( dockerfile ).toContain( `| tar xz -C /usr/local/bin just` )

    } )

    it( `installs nvm for the node user and smoke-tests it through bash`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        expect( dockerfile ).toContain( `NVM_VERSION="v0.40.4"` )
        expect( dockerfile ).toContain( `https://github.com/nvm-sh/nvm.git` )
        expect( dockerfile ).toContain( `source "$NVM_DIR/nvm.sh" && command -v nvm` )

    } )

    it( `enables common JS package managers through corepack`, () => {

        const dockerfile = readFileSync( new URL( `../src/docker/assets/Dockerfile`, import.meta.url ), `utf8` )

        expect( dockerfile ).toContain( `corepack enable` )
        expect( dockerfile ).toContain( ` pnpm ` )
        expect( dockerfile ).toContain( ` yarn ` )

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

    it( `falls back to codex latest-session resume when Babysit lacks a native id`, () => {
        expect( codex.flags.resume_latest() ).toEqual( [ `resume`, `--last` ] )
    } )

    it( `injects reasoning effort via -c model_reasoning_effort override`, () => {
        // The bare `reasoning_effort` key is silently ignored by codex; the real
        // config knob is `model_reasoning_effort`. Quote the value so it survives
        // YAML/TOML parsing inside codex's -c handler.
        expect( codex.flags.effort( `xhigh` ) ).toEqual( [ `-c`, `model_reasoning_effort="xhigh"` ] )
    } )

    it( `defaults to the latest GA model at extra-high effort`, () => {
        expect( codex.defaults.model ).toBe( `gpt-5.5` )
        expect( codex.defaults.effort ).toBe( `xhigh` )
    } )

    it( `skip_permissions bypasses both approvals and the internal sandbox`, () => {
        // We already wrap codex in our own docker sandbox; --full-auto would leave
        // codex's internal sandbox active and block edits inside babysit --yolo.
        expect( codex.flags.skip_permissions() ).toBe( `--dangerously-bypass-approvals-and-sandbox` )
    } )

    it( `can bypass the internal sandbox without skipping approvals`, () => {
        expect( codex.flags.bypass_sandbox() ).toEqual( [ `--sandbox`, `danger-full-access` ] )
    } )

} )

describe( `resume fallback flags`, () => {

    it( `uses native latest-session flags for agents when Babysit only has metadata`, () => {
        expect( claude.flags.resume_latest() ).toEqual( [ `--continue` ] )
        expect( gemini.flags.resume_latest() ).toEqual( [ `--resume`, `latest` ] )
        expect( opencode.flags.resume_latest() ).toEqual( [ `--continue` ] )
    } )

    it( `builds a supervisable codex latest-session command`, () => {

        const cmd = build_docker_command( make_options( {
            agent: codex,
            agent_args: codex.flags.resume_latest(),
        } ) )

        expect( cmd ).toContain( ` codex ` )
        expect( cmd ).toContain( ` resume --last` )
        expect( cmd ).not.toContain( ` exec resume` )
        expect( cmd ).toContain( `:/home/node/.codex/sessions` )

    } )

} )

describe( `user-globals bind-mount target`, () => {

    // Each non-claude agent declares the container path where the host's
    // ~/.agents/AGENTS.md gets bind-mounted (read-only) so the agent picks
    // it up via its own native discovery — codex's CODEX_HOME/AGENTS.md,
    // gemini's GEMINI.md, opencode's AGENTS.md, claude's CLAUDE.md.
    // Targets must be container-local — /workspace is read-only in mudbox
    // and ephemeral in sandbox, so the bind would silently fail there.

    it( `codex uses ~/.codex/AGENTS.md (NOT instructions.md — that file is no longer read)`, () => {
        // Per current OpenAI Codex docs, the global scope reads
        // AGENTS.override.md then AGENTS.md from CODEX_HOME. The legacy
        // instructions.md path is silently ignored.
        expect( codex.container_paths.user_globals_file ).toBe( `/home/node/.codex/AGENTS.md` )
        expect( codex.container_paths.user_globals_file ).not.toMatch( /instructions\.md$/ )
        expect( codex.container_paths.user_globals_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `gemini uses ~/.gemini/GEMINI.md`, () => {
        expect( gemini.container_paths.user_globals_file ).toBe( `/home/node/.gemini/GEMINI.md` )
        expect( gemini.container_paths.user_globals_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `opencode uses ~/.config/opencode/AGENTS.md`, () => {
        expect( opencode.container_paths.user_globals_file ).toBe( `/home/node/.config/opencode/AGENTS.md` )
        expect( opencode.container_paths.user_globals_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `claude uses ~/.claude/CLAUDE.md`, () => {
        expect( claude.container_paths.user_globals_file ).toBe( `/home/node/.claude/CLAUDE.md` )
        expect( claude.container_paths.user_globals_file ).not.toMatch( /^\/workspace/ )
    } )

    it( `skips a dedicated bind when an extra mount already supplies globals`, () => {

        expect( should_mount_user_globals(
            codex,
            [ { host: `/tmp/codex-home`, container: `/home/node/.codex`, provides_user_globals: true } ],
            true
        ) ).toBe( false )

        expect( should_mount_user_globals( codex, [], true ) ).toBe( true )
        expect( should_mount_user_globals( codex, [], false ) ).toBe( false )

    } )

} )

describe( `agent home env vars`, () => {

    // Each adapter declares an `home` block so build_docker_command can pin
    // the agent's home/config dir to a known container path — preventing a
    // host-leaked value from redirecting the agent to an unmounted location
    // and giving babysit a single source of truth for where global
    // instructions live.

    it( `codex declares CODEX_HOME pointing at the container codex dir`, () => {
        expect( codex.home.env_var ).toBe( `CODEX_HOME` )
        expect( codex.home.dir ).toBe( `/home/node/.codex` )
    } )

    it( `gemini declares GEMINI_CLI_HOME (parent dir — gemini creates .gemini inside)`, () => {
        expect( gemini.home.env_var ).toBe( `GEMINI_CLI_HOME` )
        expect( gemini.home.dir ).toBe( `/home/node` )
    } )

    it( `opencode declares OPENCODE_CONFIG_DIR pointing at the config dir directly`, () => {
        expect( opencode.home.env_var ).toBe( `OPENCODE_CONFIG_DIR` )
        expect( opencode.home.dir ).toBe( `/home/node/.config/opencode` )
    } )

    it( `claude declares CLAUDE_CONFIG_DIR pointing at /home/node/.claude`, () => {
        expect( claude.home.env_var ).toBe( `CLAUDE_CONFIG_DIR` )
        expect( claude.home.dir ).toBe( `/home/node/.claude` )
    } )

    it( `user_globals_file lives under the declared home dir for codex/opencode`, () => {
        // Sanity: bind-mounting the user globals to a path outside the home
        // dir would land outside the agent's native discovery scope and the
        // file would never get loaded.
        expect( codex.container_paths.user_globals_file.startsWith( codex.home.dir + `/` ) ).toBe( true )
        expect( opencode.container_paths.user_globals_file.startsWith( opencode.home.dir + `/` ) ).toBe( true )
    } )

} )

describe( `build_docker_command`, () => {

    it( `pre-creates nested file mountpoints inside tmpdir-backed config homes`, () => {

        const dir = mkdtempSync( join( tmpdir(), `babysit-nested-mount-` ) )

        try {

            expect( prepare_nested_file_mountpoint(
                [ { host: dir, container: `/home/node/.codex` } ],
                `/home/node/.codex/auth.json`
            ) ).toBe( true )

            const mountpoint = join( dir, `auth.json` )
            expect( existsSync( mountpoint ) ).toBe( true )
            expect( statSync( mountpoint ).mode & 0o777 ).toBe( 0o666 )

        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

    it( `escapes embedded single quotes in shell values`, () => {

        const cmd = build_docker_command( make_options( {
            agent: claude,
            agent_args: [ `--model`, `it's complicated` ],
        } ) )

        // 'foo'\''bar' is the POSIX way to embed a single quote in a single-quoted string
        expect( cmd ).toContain( `'it'\\''s complicated'` )

    } )

    it( `keeps initial prompts out of the docker command`, () => {

        for ( const a of [ claude, codex, gemini, opencode ] ) {
            const cmd = build_docker_command( make_options( {
                agent: a,
                config: {
                    isolate_dependencies: false,
                    initial_prompt: `Use $HOME wisely`,
                },
            } ) )

            // Initial prompts are sent through tmux send-keys after launch, not
            // as shell-visible CLI args or env vars in the docker command.
            expect( cmd ).not.toContain( `Use $HOME wisely` )
            expect( cmd ).not.toContain( `--append-system-prompt` )
            expect( cmd ).not.toContain( `--prompt` )
            expect( cmd ).not.toContain( ` -i ` )
            expect( cmd ).not.toContain( `BABYSIT_SYSTEM_PROMPT` )
        }

    } )

    it( `pins each agent's home dir via its own env var`, () => {

        // CODEX_HOME / GEMINI_CLI_HOME / OPENCODE_CONFIG_DIR / CLAUDE_CONFIG_DIR
        // are baked into the docker run so the agent reads global
        // instructions from a path babysit controls.
        expect( build_docker_command( make_options( { agent: codex } ) ) )
            .toContain( `CODEX_HOME=/home/node/.codex` )

        expect( build_docker_command( make_options( { agent: gemini } ) ) )
            .toContain( `GEMINI_CLI_HOME=/home/node` )

        expect( build_docker_command( make_options( { agent: opencode } ) ) )
            .toContain( `OPENCODE_CONFIG_DIR=/home/node/.config/opencode` )

        expect( build_docker_command( make_options( { agent: claude } ) ) )
            .toContain( `CLAUDE_CONFIG_DIR=/home/node/.claude` )

    } )

    it( `auto-applies max-effort and latest-model defaults`, () => {

        const cmd = build_docker_command( make_options( { agent: codex } ) )

        // Spec: "always auto-selects the maximum effort and latest model"
        expect( cmd ).toContain( `--model gpt-5.5` )
        // model_reasoning_effort is the real codex config key (not reasoning_effort).
        // The full-quoted form is shell_quote'd into a single arg by build_docker_command.
        expect( cmd ).toContain( `'model_reasoning_effort="xhigh"'` )

    } )

    it( `disables codex's internal sandbox without bypassing approvals outside yolo`, () => {

        const cmd = build_docker_command( make_options( {
            agent: codex,
            mode: { yolo: false },
            modifiers: [],
        } ) )

        expect( cmd ).toContain( ` codex --sandbox danger-full-access --model gpt-5.5` )
        expect( cmd ).not.toContain( `--dangerously-bypass-approvals-and-sandbox` )

    } )

    it( `renders exact native-id resume commands for each agent`, () => {

        const uuid = `019df81b-ce45-70f0-ab6e-3cbd64c83397`

        expect( build_docker_command( make_options( {
            agent: claude,
            agent_args: claude.flags.resume( uuid ),
        } ) ) ).toContain( ` claude --dangerously-skip-permissions --model opus --effort max --resume ${ uuid }` )

        expect( build_docker_command( make_options( {
            agent: codex,
            agent_args: codex.flags.resume( uuid ),
        } ) ) ).toContain( ` codex --dangerously-bypass-approvals-and-sandbox --model gpt-5.5 -c 'model_reasoning_effort="xhigh"' resume ${ uuid }` )

        expect( build_docker_command( make_options( {
            agent: gemini,
            agent_args: gemini.flags.resume( uuid ),
        } ) ) ).toContain( ` gemini --yolo --skip-trust --resume ${ uuid }` )

        expect( build_docker_command( make_options( {
            agent: opencode,
            agent_args: opencode.flags.resume( `ses_66a71b6f4ffeq796jvvOpJQ04m` ),
        } ) ) ).toContain( ` opencode --dangerously-skip-permissions --model openai/gpt-5.5 --session ses_66a71b6f4ffeq796jvvOpJQ04m` )

    } )

    it( `mounts persistent native resume state for every non-sandbox agent`, () => {

        expect( get_agent_state_mounts( claude, `/tmp/empty`, { yolo: true } ) ).toEqual( [
            { source: `babysit-claude-projects`, target: `/home/node/.claude/projects` },
            { source: `babysit-claude-plans`, target: `/home/node/.claude/plans` },
            { source: `babysit-claude-todos`, target: `/home/node/.claude/todos` },
        ] )

        const codex_cmd = build_docker_command( make_options( { agent: codex } ) )
        const codex_cmd_with_env = build_docker_command( make_options( {
            agent: codex,
            extra_env: codex.extra_env(),
        } ) )
        const gemini_cmd = build_docker_command( make_options( { agent: gemini } ) )
        const opencode_cmd = build_docker_command( make_options( { agent: opencode } ) )

        expect( codex_cmd ).toContain( `:/home/node/.codex/sessions` )
        expect( codex_cmd ).toContain( `:/home/node/.codex/sqlite` )
        expect( codex_cmd_with_env ).toContain( `CODEX_SQLITE_HOME=/home/node/.codex/sqlite` )
        expect( gemini_cmd ).toContain( `:/home/node/.gemini/tmp` )
        expect( opencode_cmd ).toContain( `:/home/node/.local/share/opencode` )

    } )

    it( `scopes non-Claude state volumes to the host-visible workspace`, async () => {

        await with_env( { BABYSIT_HOST_WORKSPACE: `/host/project` }, () => {
            const volume_name = build_agent_state_volume_name( `codex`, `sessions`, `/workspace/packages/app` )
            expect( volume_name ).toBe( build_agent_state_volume_name( `codex`, `sessions`, `/host/project/packages/app` ) )
            expect( volume_name ).toMatch( /^babysit-codex-sessions-[0-9a-f]{12}$/ )
        } )

    } )

    it( `skips persistent native resume state in sandbox mode`, () => {

        for ( const a of [ claude, codex, gemini, opencode ] ) {
            expect( get_agent_state_mounts( a, `/tmp/empty`, { sandbox: true } ) ).toEqual( [] )
        }

    } )

    it( `mounts Codex config home before narrower auth mounts`, () => {

        const cmd = build_docker_command( make_options( {
            agent: codex,
            creds_mounts: [
                { type: `volume`, source: `/tmp/codex-auth.json`, target: `/home/node/.codex/auth.json` },
            ],
        } ) )

        const home_mount_index = cmd.indexOf( `:/home/node/.codex ` )
        const auth_mount_index = cmd.indexOf( `:/home/node/.codex/auth.json` )

        expect( home_mount_index ).toBeGreaterThan( -1 )
        expect( auth_mount_index ).toBeGreaterThan( home_mount_index )

    } )

    it( `can mount credentials for inactive agents into the active agent container`, () => {

        const cmd = build_docker_command( make_options( {
            agent: codex,
            creds_mounts: [
                { type: `volume`, source: `/tmp/claude-creds.json`, target: `/home/node/.claude/.credentials.json` },
                { type: `volume`, source: `/tmp/codex-auth.json`, target: `/home/node/.codex/auth.json` },
                { type: `volume`, source: `/tmp/gemini-oauth.json`, target: `/home/node/.gemini/oauth_creds.json` },
                { type: `volume`, source: `/tmp/opencode-auth.json`, target: `/home/node/.local/share/opencode/auth.json` },
            ],
        } ) )

        expect( cmd ).toContain( `/tmp/claude-creds.json:/home/node/.claude/.credentials.json` )
        expect( cmd ).toContain( `/tmp/codex-auth.json:/home/node/.codex/auth.json` )
        expect( cmd ).toContain( `/tmp/gemini-oauth.json:/home/node/.gemini/oauth_creds.json` )
        expect( cmd ).toContain( `/tmp/opencode-auth.json:/home/node/.local/share/opencode/auth.json` )

    } )

    it( `does not bind-mount claude's writable session dirs in sandbox mode`, () => {

        // RO-mounting projects/plans/todos in sandbox would crash claude on its
        // first session-state write — sandbox should let claude write
        // ephemerally inside the container instead.
        const cmd = build_docker_command( make_options( {
            agent: claude,
            mode: { sandbox: true },
            modifiers: [ `sandbox` ],
        } ) )

        expect( cmd ).not.toContain( `/home/node/.claude/projects` )
        expect( cmd ).not.toContain( `/home/node/.claude/plans` )
        expect( cmd ).not.toContain( `/home/node/.claude/todos` )

    } )

    it( `mounts ~/.agents read-write with --group-add when present`, async () => {

        // The host directory is often owned by a uid/gid that doesn't match
        // the container's `node` user. RO mounting silently broke reads under
        // restrictive group perms; RW + supplementary group means the agent
        // can read AND persist memories/skills back, with files inheriting the
        // host gid (via SGID on the dir) so they stay editable on the host.
        const { existsSync, statSync } = await import( `fs` )
        const { homedir } = await import( `os` )
        const { join } = await import( `path` )

        const real_agents = join( homedir(), `.agents` )
        if( !existsSync( real_agents ) ) return // host has no ~/.agents — nothing to assert

        const cmd = build_docker_command( make_options() )
        expect( cmd ).toContain( `:/home/node/.agents ` ) // mount target without :ro
        expect( cmd ).not.toContain( `/home/node/.agents:ro` )
        const { gid } = statSync( real_agents )
        expect( cmd ).toContain( `--group-add ${ gid }` )

    } )

    it( `mounts the host Docker socket when --docker is enabled`, () => {

        const tmpdir_path = mkdtempSync( join( tmpdir(), `babysit-docker-socket-` ) )
        const socket_path = join( tmpdir_path, `docker.sock` )

        try {
            writeFileSync( socket_path, `` )
            chmodSync( socket_path, 0o660 )

            const cmd = build_docker_command( make_options( {
                mode: { yolo: true, docker: true },
                modifiers: [ `yolo`, `docker` ],
                docker_socket_path: socket_path,
            } ) )

            expect( cmd ).toContain( `${ socket_path }:/var/run/docker.sock` )
            expect( cmd ).toContain( `DOCKER_HOST=unix:///var/run/docker.sock` )
            expect( cmd ).toContain( `BABYSIT_DOCKER=1` )
            expect( cmd ).toContain( `BABYSIT_HOST_WORKSPACE=/tmp/empty` )
            expect( cmd ).toContain( `BABYSIT_MODIFIERS=yolo·docker` )
        } finally {
            rmSync( tmpdir_path, { recursive: true, force: true } )
        }

    } )

    it( `can run docker through sudo for containerized E2E hosts`, async () => {
        await with_env( { BABYSIT_DOCKER_USE_SUDO: `1` }, () => {
            const cmd = build_docker_command( make_options() )
            expect( cmd.startsWith( `sudo docker run` ) ).toBe( true )
        } )
    } )

    it( `labels and forwards E2E metadata when present`, async () => {
        await with_env( {
            BABYSIT_E2E_RUN_ID: `run-123`,
            BABYSIT_E2E_SIBLING_IMAGE: `babysit:e2e-fake`,
            BABYSIT_DOCKER_IMAGE: `babysit:e2e-fake`,
        }, () => {
            const cmd = build_docker_command( make_options() )
            expect( cmd ).toContain( `--label babysit.e2e_run=run-123` )
            expect( cmd ).toContain( `BABYSIT_E2E_RUN_ID=run-123` )
            expect( cmd ).toContain( `BABYSIT_E2E_SIBLING_IMAGE=babysit:e2e-fake` )
            expect( cmd ).toContain( ` babysit:e2e-fake ` )
        } )
    } )

    it( `maps nested /workspace paths back to the host workspace`, () => {

        const previous = process.env.BABYSIT_HOST_WORKSPACE
        process.env.BABYSIT_HOST_WORKSPACE = `/host/project`

        try {
            expect( resolve_workspace_mount_source( `/workspace` ) ).toBe( `/host/project` )
            expect( resolve_workspace_mount_source( `/workspace/packages/app` ) ).toBe( `/host/project/packages/app` )
            expect( resolve_workspace_mount_source( `/tmp/other` ) ).toBe( `/tmp/other` )
        } finally {
            if( previous === undefined ) delete process.env.BABYSIT_HOST_WORKSPACE
            else process.env.BABYSIT_HOST_WORKSPACE = previous
        }

    } )

    it( `maps all /workspace bind mount sources back to the host workspace`, async () => {
        await with_env( { BABYSIT_HOST_WORKSPACE: `/host/project` }, () => {
            const cmd = build_docker_command( make_options( {
                workspace: `/workspace/e2e`,
                creds_mounts: [
                    { type: `volume`, source: `/workspace/tmp/auth.json`, target: `/home/node/.codex/auth.json` },
                ],
            } ) )

            expect( cmd ).toContain( `/host/project/e2e:/workspace` )
            expect( cmd ).toContain( `/host/project/tmp/auth.json:/home/node/.codex/auth.json` )
        } )
    } )

} )

describe( `dependency-volume detection`, () => {

    // Importing inside the test keeps the module lookup explicit
    it( `detects bun.lock (Bun 1.2+ text format) as a Node project`, async () => {

        const { detect_dependency_volumes } = await import( `../src/docker/volumes.js` )
        const { mkdtempSync, writeFileSync, rmSync } = await import( `fs` )
        const { join: pjoin } = await import( `path` )
        const { tmpdir: ostmp } = await import( `os` )

        const dir = mkdtempSync( pjoin( ostmp(), `babysit-buntest-` ) )
        try {
            writeFileSync( pjoin( dir, `bun.lock` ), `# bun lockfile` )
            const volumes = detect_dependency_volumes( dir )
            const node_volume = volumes.find( v => v.container_path === `/workspace/node_modules` )
            expect( node_volume ).toBeDefined()
        } finally {
            rmSync( dir, { recursive: true, force: true } )
        }

    } )

} )
