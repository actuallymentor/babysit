import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { log } from '../utils/log.js'
import { get_image_name } from './update.js'
import { detect_dependency_volumes } from './volumes.js'
import { AGENTS_DIR } from '../utils/paths.js'
import { LOOP_DEADLINE_CONTAINER_PATH, LOOP_DEADLINE_PATH } from '../statusline/render.js'
import { get_extra_mounts } from '../agents/setup.js'

export const DEFAULT_DOCKER_SOCKET = `/var/run/docker.sock`

/**
 * Extract a Unix socket path from a Docker host URI.
 * @param {string} docker_host - DOCKER_HOST-style URI
 * @returns {string|null} Local Unix socket path, or null for unsupported hosts
 */
export const docker_host_socket_path = ( docker_host = `` ) => {

    const value = String( docker_host || `` ).trim()
    if( !value.startsWith( `unix://` ) ) return null

    const socket_path = value.slice( `unix://`.length )
    return socket_path || null

}

/**
 * Host socket paths Babysit can mount into a Docker-outside-of-Docker session.
 * Docker Desktop for Mac may not create /var/run/docker.sock unless that
 * privileged symlink option is enabled, but the user-scoped socket still works.
 * @param {Object} [options]
 * @param {Object} [options.env=process.env] - Environment to inspect
 * @param {string} [options.home=homedir()] - Host home directory
 * @param {string} [options.platform=process.platform] - Host platform
 * @returns {string[]} Candidate Unix socket paths
 */
export const docker_socket_candidates = ( {
    env = process.env,
    home = homedir(),
    platform = process.platform,
} = {} ) => {

    const mac_socket_paths = platform === `darwin`
        ? [
            join( home, `.docker`, `run`, `docker.sock` ),
            join( home, `Library`, `Containers`, `com.docker.docker`, `Data`, `docker.sock` ),
        ]
        : []

    const candidates = [
        docker_host_socket_path( env.DOCKER_HOST ),
        DEFAULT_DOCKER_SOCKET,
        ...mac_socket_paths,
    ].filter( Boolean )

    return [ ...new Set( candidates ) ]

}

/**
 * Read the active Docker CLI context and return its Unix socket, when local.
 * @param {Object} [options]
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for process spawn
 * @returns {string|null} Local Unix socket path from the active Docker context
 */
export const docker_context_socket_path = ( { spawn_sync = spawnSync } = {} ) => {

    const result = spawn_sync( `docker`, [
        `context`,
        `inspect`,
        `--format`,
        `{{ .Endpoints.docker.Host }}`,
    ], {
        encoding: `utf8`,
        stdio: [ `ignore`, `pipe`, `ignore` ],
        timeout: 2_000,
    } )

    if( result.error || result.status !== 0 ) return null

    return docker_host_socket_path( result.stdout )

}

/**
 * Find a host Docker socket that can be bind-mounted into the agent container.
 * @param {Object} [options]
 * @param {Function} [options.exists=existsSync] - Test seam for file existence
 * @returns {string|null} Existing local Unix socket path
 */
export const resolve_docker_socket_path = ( options = {} ) => {

    const { exists = existsSync, env = process.env } = options

    const env_socket = docker_host_socket_path( env.DOCKER_HOST )
    if( env_socket && exists( env_socket ) ) return env_socket

    const context_socket = docker_context_socket_path( options )
    if( context_socket && exists( context_socket ) ) return context_socket

    const fallback_sockets = docker_socket_candidates( { ...options, env: {} } )
    const fallback_socket = fallback_sockets.find( socket_path => exists( socket_path ) )
    if( fallback_socket ) return fallback_socket

    return null

}

/**
 * Single-quote a value for safe inclusion in a `sh -c` command string.
 * Strings made up of POSIX-portable filename chars are passed through unquoted
 * so the rendered command stays readable in logs.
 * @param {string} value - The value to escape
 * @returns {string} Shell-safe representation
 */
const shell_quote = ( value ) => {

    const str = String( value )

    if( str === `` ) return `''`

    // Alphanumerics + URL/path-safe punctuation — none of these are shell-special.
    if( /^[a-zA-Z0-9_=:./@%+,-]+$/.test( str ) ) return str

    // Wrap in single quotes; escape embedded single quotes by closing/reopening: 'foo'\''bar'
    return `'${ str.replace( /'/g, `'\\''` ) }'`

}

/**
 * Check whether the host Docker socket is available.
 * @param {string} [socket_path=resolve_docker_socket_path()] - Host Docker socket path
 * @returns {boolean} True when the socket path exists
 */
export const docker_socket_available = ( socket_path = resolve_docker_socket_path() ) => Boolean( socket_path && existsSync( socket_path ) )

const get_docker_prefix = () => process.env.BABYSIT_DOCKER_USE_SUDO === `1`
    ? [ `sudo`, `docker` ]
    : [ `docker` ]

/**
 * Check whether the Docker CLI can talk to the daemon before Babysit creates
 * a tmux session around `docker run`.
 * @param {Object} [options]
 * @param {Function} [options.spawn_sync=spawnSync] - Test seam for process spawn
 * @returns {{ available: boolean, reason?: string, version?: string }} Docker daemon status
 */
export const docker_daemon_status = ( { spawn_sync = spawnSync } = {} ) => {

    const [ cmd, ...prefix_args ] = get_docker_prefix()
    let result

    try {
        result = spawn_sync( cmd, [
            ...prefix_args,
            `info`,
            `--format`,
            `{{.ServerVersion}}`,
        ], {
            encoding: `utf8`,
            stdio: [ `ignore`, `pipe`, `pipe` ],
            timeout: 5_000,
        } )
    } catch ( error ) {
        return {
            available: false,
            reason: error.message,
        }
    }

    if( result.error ) {
        return {
            available: false,
            reason: result.error.message,
        }
    }

    if( result.status !== 0 ) {
        const diagnostic = ( result.stderr || result.stdout || `` ).trim()

        return {
            available: false,
            reason: diagnostic || `${ cmd } ${ prefix_args.concat( `info` ).join( ` ` ) } exited with code ${ result.status }`,
        }
    }

    return {
        available: true,
        version: String( result.stdout || `` ).trim(),
    }

}

/**
 * Map an in-container /workspace path back to the original daemon-host path.
 * Docker bind mounts are resolved by the daemon host, so nested Babysit runs
 * cannot use /workspace as a source path when talking to the host socket.
 * @param {string} workspace - Current process workspace
 * @returns {string} Host-visible source path for docker bind mounts
 */
export const resolve_workspace_mount_source = ( workspace ) => {

    const host_workspace = process.env.BABYSIT_HOST_WORKSPACE
    if( !host_workspace ) return workspace

    if( workspace === `/workspace` ) return host_workspace
    if( workspace.startsWith( `/workspace/` ) ) return join( host_workspace, workspace.slice( `/workspace/`.length ) )

    return workspace

}

/**
 * Add host Docker socket flags for Docker-outside-of-Docker.
 * @param {string[]} flags - Docker command argument list to mutate
 * @param {Object} options
 * @param {string} options.socket_path - Host Docker socket path
 * @param {string} options.workspace_source - Host-visible workspace path
 */
const add_docker_socket_flags = ( flags, { socket_path, workspace_source } ) => {

    if( !docker_socket_available( socket_path ) ) {
        throw new Error( `--docker requested, but ${ socket_path } is not available on the host.` )
    }

    flags.push( `-v`, `${ socket_path }:${ DEFAULT_DOCKER_SOCKET }` )
    flags.push( `-e`, `DOCKER_HOST=unix://${ DEFAULT_DOCKER_SOCKET }` )
    flags.push( `-e`, `BABYSIT_DOCKER=1` )
    flags.push( `-e`, `BABYSIT_HOST_WORKSPACE=${ workspace_source }` )

    try {
        const { gid } = statSync( socket_path )
        flags.push( `--group-add`, String( gid ) )
    } catch ( e ) {
        log.debug( `Could not stat ${ socket_path } for group-add: ${ e.message }` )
    }

}

const get_docker_run_prefix = () => [ ...get_docker_prefix(), `run` ]

/**
 * Build a stable Docker volume name for agent state scoped to a workspace.
 * @param {string} agent_name - Agent adapter name
 * @param {string} label - State label, e.g. sessions/sqlite/tmp
 * @param {string} workspace - Current workspace path
 * @returns {string} Docker volume name
 */
export const build_agent_state_volume_name = ( agent_name, label, workspace ) => {

    const workspace_source = resolve_workspace_mount_source( workspace )
    const path_hash = createHash( `sha256` ).update( workspace_source ).digest( `hex` ).slice( 0, 12 )

    return `babysit-${ agent_name }-${ label }-${ path_hash }`

}

/**
 * Persistent agent-local state needed for native resume commands.
 * @param {Object} agent - Agent adapter
 * @param {string} workspace - Current workspace path
 * @param {Object} mode - Mode config
 * @returns {{ source: string, target: string }[]} Docker volume mounts
 */
export const get_agent_state_mounts = ( agent, workspace, mode = {} ) => {

    // Sandbox mode is deliberately ephemeral: no host workspace, no persistent
    // agent transcript volumes. This preserves the existing Claude behavior and
    // keeps sandbox resumes from leaking local state across isolated runs.
    if( mode.sandbox ) return []

    const scoped = label => build_agent_state_volume_name( agent.name, label, workspace )

    if( agent.name === `claude` ) {
        return [
            { source: `babysit-claude-projects`, target: `/home/node/.claude/projects` },
            { source: `babysit-claude-plans`, target: `/home/node/.claude/plans` },
            { source: `babysit-claude-todos`, target: `/home/node/.claude/todos` },
        ]
    }

    if( agent.name === `codex` ) {
        return [
            { source: scoped( `sessions` ), target: `/home/node/.codex/sessions` },
            { source: scoped( `sqlite` ), target: `/home/node/.codex/sqlite` },
        ]
    }

    if( agent.name === `gemini` ) {
        return [
            { source: scoped( `tmp` ), target: `/home/node/.gemini/tmp` },
        ]
    }

    if( agent.name === `opencode` ) {
        return [
            { source: scoped( `data` ), target: `/home/node/.local/share/opencode` },
        ]
    }

    return []

}

/**
 * Decide whether the shared ~/.agents/AGENTS.md file needs a dedicated bind.
 * Some agent config mounts, currently Codex's whole CODEX_HOME tmpdir, seed
 * the globals file internally to avoid Docker nested-bind failures.
 * @param {Object} agent - Agent adapter
 * @param {Object[]} extra_mounts - Per-agent extra mount descriptors
 * @param {boolean} user_globals_exists - Whether ~/.agents/AGENTS.md exists
 * @returns {boolean}
 */
export const should_mount_user_globals = ( agent = {}, extra_mounts = [], user_globals_exists = false ) => {

    const user_globals_supplied = extra_mounts.some( m => m.provides_user_globals )

    return Boolean( user_globals_exists && agent.container_paths?.user_globals_file && !user_globals_supplied )

}

/**
 * Pre-create file targets for nested bind mounts inside whole-directory
 * config mounts. Docker Desktop cannot create the mountpoint itself once the
 * parent is already backed by a host tmpdir.
 * @param {Object[]} extra_mounts - Per-agent extra mount descriptors
 * @param {string} target_path - Container file path for a later bind mount
 * @returns {boolean} True when a nested mountpoint was prepared
 */
export const prepare_nested_file_mountpoint = ( extra_mounts = [], target_path ) => {

    const parent_mount = extra_mounts.find( m => target_path.startsWith( `${ m.container }/` ) )
    if( !parent_mount ) return false

    const relative_target = target_path.slice( parent_mount.container.length + 1 )
    const mountpoint = join( parent_mount.host, relative_target )

    mkdirSync( dirname( mountpoint ), { recursive: true } )
    if( !existsSync( mountpoint ) ) writeFileSync( mountpoint, `` )
    chmodSync( mountpoint, 0o666 )

    return true

}

/**
 * Build the full `docker run` command argv for launching a coding agent.
 * @param {Object} options
 * @param {Object} options.agent - Agent adapter
 * @param {string} options.workspace - Host working directory
 * @param {Object} options.mode - Mode config { yolo, sandbox, mudbox }
 * @param {string[]} options.agent_args - Extra args to pass to the agent CLI
 * @param {Object} options.creds_mounts - Credential mount specs from credentials module
 * @param {Object} options.config - babysit.yaml config section
 * @param {Object} [options.extra_env={}] - Extra environment variables
 * @param {string[]} [options.modifiers=[]] - Active mode modifiers (yolo, mudbox, sandbox, loop) for the statusline
 * @param {string} [options.docker_socket_path=DEFAULT_DOCKER_SOCKET] - Host Docker socket path for --docker
 * @param {boolean} [options.interactive=true] - Whether to allocate stdin + TTY
 * @param {boolean} [options.mount_workspace=true] - Whether to bind-mount the host workspace
 * @param {boolean} [options.include_agents_dir=true] - Whether to mount the shared ~/.agents directory
 * @param {boolean} [options.include_user_globals=true] - Whether to mount ~/.agents/AGENTS.md into the agent home
 * @param {boolean} [options.include_loop_deadline=true] - Whether to mount the statusline loop deadline file
 * @param {boolean} [options.include_agent_state=true] - Whether to mount persistent native resume state
 * @param {string[]|null} [options.agent_command=null] - Full command to run inside the image
 * @returns {string[]} Docker argv
 */
export const build_docker_command_args = ( options ) => {

    const {
        agent,
        workspace,
        mode = {},
        agent_args = [],
        creds_mounts = [],
        config = {},
        extra_env = {},
        modifiers = [],
        interactive = true,
        mount_workspace = true,
        include_agents_dir = true,
        include_user_globals = true,
        include_loop_deadline = true,
        include_agent_state = true,
        agent_command = null,
    } = options
    const flags = []
    const workspace_source = resolve_workspace_mount_source( workspace )
    const docker_socket_path = mode.docker
        ? options.docker_socket_path || DEFAULT_DOCKER_SOCKET
        : null

    // Base docker run flags
    flags.push( ...get_docker_run_prefix(), `--rm` )
    if( interactive ) flags.push( `-it` )
    flags.push( `--name`, `babysit-${ agent.name }-${ Date.now() }` )

    if( process.env.BABYSIT_E2E_RUN_ID ) {
        flags.push( `--label`, `babysit.e2e_run=${ process.env.BABYSIT_E2E_RUN_ID }` )
    }

    // Workspace mount (mode-dependent)
    if( !mount_workspace ) {
        log.debug( `Workspace mount disabled for docker command` )
    } else if( mode.sandbox ) {
        // Sandbox: no workspace mount — ephemeral
        log.debug( `Sandbox mode: workspace not mounted` )
    } else if( mode.mudbox ) {
        // Mudbox: read-only
        flags.push( `-v`, `${ workspace_source }:/workspace:ro` )
    } else {
        // Default / yolo: read-write
        flags.push( `-v`, `${ workspace_source }:/workspace` )
    }

    // Mount ~/.agents read-write so agents can persist memories, skills, and
    // other state back to the host. The host directory is often owned by a uid
    // that doesn't match the container's `node` user (1000), which would block
    // reads through DAC. Sidestep that by adding the host directory's gid as a
    // supplementary group on the container user — group perms on the bind mount
    // then grant access, and SGID (when set on the host dir) keeps files the
    // agent writes back inheriting the host group so the host user can still
    // edit them. Per-file read-only is preserved via host file perms.
    if( include_agents_dir && existsSync( AGENTS_DIR ) ) {
        flags.push( `-v`, `${ resolve_workspace_mount_source( AGENTS_DIR ) }:/home/node/.agents` )
        try {
            const { gid } = statSync( AGENTS_DIR )
            flags.push( `--group-add`, String( gid ) )
        } catch ( e ) {
            log.debug( `Could not stat ${ AGENTS_DIR } for group-add: ${ e.message }` )
        }
    }

    // Dependency volume isolation (unless disabled in config)
    if( mount_workspace && config.isolate_dependencies !== false && !mode.sandbox ) {

        const dep_volumes = detect_dependency_volumes( workspace )

        for( const vol of dep_volumes ) {
            flags.push( `-v`, `${ vol.volume_name }:${ vol.container_path }` )
            flags.push( `-e`, `${ vol.env_key }=1` )
        }

    }

    // Cache volumes (persistent across sessions)
    flags.push( `-v`, `babysit-npm-cache:/home/node/.npm` )
    flags.push( `-v`, `babysit-npm-global:/home/node/.npm-global` )
    flags.push( `-v`, `babysit-uv-cache:/home/node/.cache` )

    // Mode environment
    if( mode.yolo ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=yolo` )
    else if( mode.sandbox ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=sandbox` )
    else if( mode.mudbox ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=mudbox` )

    if( mode.docker ) add_docker_socket_flags( flags, { socket_path: docker_socket_path, workspace_source } )

    for( const key of [ `BABYSIT_E2E_RUN_ID`, `BABYSIT_E2E_SIBLING_IMAGE`, `BABYSIT_DOCKER_IMAGE` ] ) {
        if( process.env[ key ] ) flags.push( `-e`, `${ key }=${ process.env[ key ] }` )
    }

    // Modifiers shown in the statusline (defaults to "babysit" if no flags)
    const modifier_label = modifiers.length ? modifiers.join( `·` ) : `babysit`
    flags.push( `-e`, `BABYSIT_MODIFIERS=${ modifier_label }` )

    // Pin the agent's home/config directory inside the container. Each agent
    // exposes its own env var (CODEX_HOME, GEMINI_CLI_HOME, CLAUDE_CONFIG_DIR,
    // OPENCODE_CONFIG_DIR). Setting it explicitly gives babysit a single
    // source of truth for where the agent reads global instructions and
    // credentials from — and stops a stray host-side value from redirecting
    // the agent to a path we never mount.
    if( agent.home?.env_var && agent.home?.dir ) {
        flags.push( `-e`, `${ agent.home.env_var }=${ agent.home.dir }` )
    }

    // Per-agent extra config mounts. Mount these before credential and
    // user-global files so a whole-dir mount (Codex needs this for atomic
    // config.toml persists) can act as the base config home, then narrower
    // file mounts layer into it.
    const extra_mounts = get_extra_mounts( agent.name )( { yolo: mode.yolo } )
    for( const m of extra_mounts ) {
        const target = m.ro ? `${ m.container }:ro` : m.container
        flags.push( `-v`, `${ resolve_workspace_mount_source( m.host ) }:${ target }` )
    }

    // Agent-native resume state. Claude already needed this for projects/plans/
    // todos; Codex, Gemini, and OpenCode also store local transcripts/session
    // indexes outside auth files, so fresh containers need persistent volumes
    // here or `resume --last` / `--session <id>` starts from an empty install.
    if( include_agent_state ) {
        for( const m of get_agent_state_mounts( agent, workspace, mode ) ) {
            flags.push( `-v`, `${ m.source }:${ m.target }` )
        }
    }

    // Credential mounts
    if( creds_mounts ) {
        for( const mount of creds_mounts ) {
            if( mount.type === `volume` ) {
                prepare_nested_file_mountpoint( extra_mounts, mount.target )
                const target = mount.ro ? `${ mount.target }:ro` : mount.target
                flags.push( `-v`, `${ resolve_workspace_mount_source( mount.source ) }:${ target }` )
            } else if( mount.type === `env` ) {
                flags.push( `-e`, `${ mount.key }=${ mount.value }` )
            }
        }
    }

    // Git identity from host (override defaults in Dockerfile)
    const git_vars = [ `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_EMAIL` ]
    for( const key of git_vars ) {
        if( process.env[ key ] ) flags.push( `-e`, `${ key }=${ process.env[ key ] }` )
    }

    // Bind-mount the user's cross-agent globals into each agent's native
    // discovery path (read-only). The agent loads it through its own
    // AGENTS.md / GEMINI.md / CLAUDE.md mechanism — no babysit-specific
    // configuration needed inside the container. Conditional on the host
    // file existing so a missing ~/.agents/AGENTS.md leaves the agent in
    // its vanilla state.
    const user_agents_md = join( AGENTS_DIR, `AGENTS.md` )
    if( include_user_globals && should_mount_user_globals( agent, extra_mounts, existsSync( user_agents_md ) ) ) {
        prepare_nested_file_mountpoint( extra_mounts, agent.container_paths.user_globals_file )
        flags.push( `-v`, `${ resolve_workspace_mount_source( user_agents_md ) }:${ agent.container_paths.user_globals_file }:ro` )
    }

    // Loop deadline — bind-mount so the in-container statusline can read host-written countdowns
    if( include_loop_deadline ) {
        flags.push( `-v`, `${ resolve_workspace_mount_source( LOOP_DEADLINE_PATH ) }:${ LOOP_DEADLINE_CONTAINER_PATH }:ro` )
    }

    // Extra environment variables from agent adapter
    for( const [ key, value ] of Object.entries( extra_env ) ) {
        flags.push( `-e`, `${ key }=${ value }` )
    }

    // Docker image
    flags.push( get_image_name() )

    // Agent command with flags
    const agent_cmd = agent_command || build_agent_command( agent, mode, agent_args )
    flags.push( ...agent_cmd )

    return flags

}

/**
 * Build the shell-quoted `docker run` command string for launching a coding agent.
 * @param {Object} options - Docker command options
 * @returns {string} The full docker run command string
 */
export const build_docker_command = ( options ) => {

    // The result is consumed by `sh -c` (see tmux/session.js create_session),
    // so each argument needs proper shell-quoting — passthrough args and env
    // values can contain spaces, `$`, etc.
    return build_docker_command_args( options ).map( shell_quote ).join( ` ` )

}

/**
 * Build the coding agent command with all flags
 * @param {Object} agent - Agent adapter
 * @param {Object} mode - Mode flags
 * @param {string[]} agent_args - Extra args for the agent
 * @returns {string[]} Command parts
 */
const build_agent_command = ( agent, mode, agent_args ) => {

    const parts = [ agent.bin ]

    // Skip permissions in yolo mode
    if( mode.yolo && agent.flags.skip_permissions ) {
        const flag = agent.flags.skip_permissions()
        if( Array.isArray( flag ) ) parts.push( ...flag )
        else parts.push( flag )
    } else if( agent.flags.bypass_sandbox ) {
        const flag = agent.flags.bypass_sandbox()
        if( Array.isArray( flag ) ) parts.push( ...flag )
        else parts.push( flag )
    }

    // Max model and effort
    if( agent.defaults?.model && agent.flags.model ) {
        const flag = agent.flags.model( agent.defaults.model )
        if( Array.isArray( flag ) ) parts.push( ...flag )
        else parts.push( flag )
    }

    if( agent.defaults?.effort && agent.flags.effort ) {
        const flag = agent.flags.effort( agent.defaults.effort )
        if( Array.isArray( flag ) ) parts.push( ...flag )
        else parts.push( flag )
    }

    // Per-agent extra CLI args — typically headless / trust-skip flags that
    // can't be set declaratively via state files (e.g. gemini's --skip-trust).
    // Pushed before passthrough so user overrides win on conflicting flags.
    if( agent.extra_args ) {
        const extra = agent.extra_args( mode )
        if( Array.isArray( extra ) && extra.length ) parts.push( ...extra )
    }

    // Passthrough args (unknown flags go to the agent CLI)
    if( agent_args.length ) parts.push( ...agent_args )

    return parts

}
