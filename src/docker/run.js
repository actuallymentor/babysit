import { homedir } from 'os'
import { join } from 'path'
import { existsSync } from 'fs'
import { log } from '../utils/log.js'
import { get_image_name } from './update.js'
import { detect_dependency_volumes } from './volumes.js'
import { AGENTS_DIR } from '../utils/paths.js'
import { build_claude_settings_tmpfile, LOOP_DEADLINE_PATH } from '../statusline/render.js'

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
 * Build the full `docker run` command argv for launching a coding agent
 * @param {Object} options
 * @param {Object} options.agent - Agent adapter
 * @param {string} options.workspace - Host working directory
 * @param {Object} options.mode - Mode config { yolo, sandbox, mudbox }
 * @param {string} options.system_prompt - Full system prompt to inject
 * @param {string[]} options.agent_args - Extra args to pass to the agent CLI
 * @param {Object} options.creds_mounts - Credential mount specs from credentials module
 * @param {Object} options.config - babysit.yaml config section
 * @param {Object} [options.extra_env={}] - Extra environment variables
 * @param {string[]} [options.modifiers=[]] - Active mode modifiers (yolo, mudbox, sandbox, loop) for the statusline
 * @returns {string} The full docker run command string
 */
export const build_docker_command = ( options ) => {

    const { agent, workspace, mode, system_prompt, agent_args, creds_mounts, config, extra_env = {}, modifiers = [] } = options
    const home = homedir()
    const flags = []

    // Base docker run flags
    flags.push( `docker`, `run`, `--rm`, `-it` )
    flags.push( `--name`, `babysit-${ agent.name }-${ Date.now() }` )

    // Workspace mount (mode-dependent)
    if( mode.sandbox ) {
        // Sandbox: no workspace mount — ephemeral
        log.debug( `Sandbox mode: workspace not mounted` )
    } else if( mode.mudbox ) {
        // Mudbox: read-only
        flags.push( `-v`, `${ workspace }:/workspace:ro` )
    } else {
        // Default / yolo: read-write
        flags.push( `-v`, `${ workspace }:/workspace` )
    }

    // Always mount ~/.agents read-only (if it exists)
    if( existsSync( AGENTS_DIR ) ) {
        flags.push( `-v`, `${ AGENTS_DIR }:/home/node/.agents:ro` )
    }

    // Dependency volume isolation (unless disabled in config)
    if( config.isolate_dependencies !== false && !mode.sandbox ) {

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

    // Credential mounts
    if( creds_mounts ) {
        for( const mount of creds_mounts ) {
            if( mount.type === `volume` ) {
                flags.push( `-v`, `${ mount.source }:${ mount.target }` )
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

    // GitHub token passthrough
    const gh_token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
    if( gh_token ) flags.push( `-e`, `GH_TOKEN=${ gh_token }` )

    // Mode environment
    if( mode.yolo ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=yolo` )
    else if( mode.sandbox ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=sandbox` )
    else if( mode.mudbox ) flags.push( `-e`, `AGENT_AUTONOMY_MODE=mudbox` )

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

    // For agents that don't accept a system-prompt CLI flag, hand the prompt
    // to the entrypoint via env vars so it can be written to the file the
    // agent expects (e.g. AGENTS.md, GEMINI.md). Skipped for claude.
    if( system_prompt && !agent.flags.append_system_prompt && agent.container_paths?.system_prompt_file ) {
        flags.push( `-e`, `BABYSIT_SYSTEM_PROMPT=${ system_prompt }` )
        flags.push( `-e`, `BABYSIT_SYSTEM_PROMPT_FILE=${ agent.container_paths.system_prompt_file }` )
    }

    // Loop deadline — bind-mount so the in-container statusline can read host-written countdowns
    flags.push( `-v`, `${ LOOP_DEADLINE_PATH }:${ LOOP_DEADLINE_PATH }:ro` )

    // Extra environment variables from agent adapter
    for( const [ key, value ] of Object.entries( extra_env ) ) {
        flags.push( `-e`, `${ key }=${ value }` )
    }

    // Claude-specific mounts
    if( agent.name === `claude` ) {

        // projects/plans/todos hold session state claude WRITES to. RO-mounting
        // them in sandbox would crash claude on first write — and the host
        // shouldn't be touched in sandbox mode anyway. Skip these mounts in
        // sandbox so claude writes ephemerally inside the container.
        if( !mode.sandbox ) {

            const claude_dirs = [
                [ `${ home }/.claude/projects`, `/home/node/.claude/projects` ],
                [ `${ home }/.claude/plans`, `/home/node/.claude/plans` ],
                [ `${ home }/.claude/todos`, `/home/node/.claude/todos` ],
            ]

            for( const [ host_path, container_path ] of claude_dirs ) {
                if( existsSync( host_path ) ) {
                    flags.push( `-v`, `${ host_path }:${ container_path }` )
                }
            }

        }

        // Claude settings — merge host's settings with the babysit statusline override.
        // We mount a tmpfile (not the host file) so we never mutate the user's settings.json.
        const host_settings_path = join( home, `.claude`, `settings.json` )
        const settings_tmpfile = build_claude_settings_tmpfile( host_settings_path )
        if( settings_tmpfile ) {
            flags.push( `-v`, `${ settings_tmpfile }:/home/node/.claude/settings.json` )
        }

        // Claude CLAUDE.md (read-only metadata, safe to mount in any mode)
        const claude_md = join( home, `.claude`, `CLAUDE.md` )
        if( existsSync( claude_md ) ) {
            flags.push( `-v`, `${ claude_md }:/home/node/.claude/CLAUDE.md:ro` )
        }

        // Claude skills (read-only)
        const skills_dir = join( home, `.claude`, `skills` )
        if( existsSync( skills_dir ) ) {
            flags.push( `-v`, `${ skills_dir }:/home/node/.claude/skills:ro` )
        }

    }

    // Docker image
    flags.push( get_image_name() )

    // Agent command with flags
    const agent_cmd = build_agent_command( agent, mode, system_prompt, agent_args )
    flags.push( ...agent_cmd )

    // The result is consumed by `sh -c` (see tmux/session.js create_session),
    // so each argument needs proper shell-quoting — system prompts contain
    // spaces, env values can contain `$`, etc.
    return flags.map( shell_quote ).join( ` ` )

}

/**
 * Build the coding agent command with all flags
 * @param {Object} agent - Agent adapter
 * @param {Object} mode - Mode flags
 * @param {string} system_prompt - System prompt to inject
 * @param {string[]} agent_args - Extra args for the agent
 * @returns {string[]} Command parts
 */
const build_agent_command = ( agent, mode, system_prompt, agent_args ) => {

    const parts = [ agent.bin ]

    // Skip permissions in yolo mode
    if( mode.yolo && agent.flags.skip_permissions ) {
        const flag = agent.flags.skip_permissions()
        if( Array.isArray( flag ) ) parts.push( ...flag )
        else parts.push( flag )
    }

    // System prompt injection
    if( system_prompt && agent.flags.append_system_prompt ) {
        const flag = agent.flags.append_system_prompt( system_prompt )
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

    // Passthrough args (unknown flags go to the agent CLI)
    if( agent_args.length ) parts.push( ...agent_args )

    return parts

}
