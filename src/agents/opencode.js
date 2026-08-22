/**
 * OpenCode adapter
 * CLI docs: https://opencode.ai/docs/cli/
 */
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'

import { resolve_opencode_route_config } from './opencode_config.js'

export const OPENCODE_DEFAULT_MODEL = `openai/gpt-5.6-sol`
export const OPENCODE_OPENROUTER_DEFAULT_MODEL = `openrouter/openai/gpt-5.6-sol`
export const OPENCODE_CREDENTIAL_FILE = `~/.local/share/opencode/auth.json`
export const OPENCODE_AUTH_AGENT = `babysit-auth`
export const OPENCODE_AUTH_PROFILE_VERSION = `tool-free-v1`

const PROVIDER_DEFAULT_MODELS = {
    openrouter: OPENCODE_OPENROUTER_DEFAULT_MODEL,
    openai: OPENCODE_DEFAULT_MODEL,
}

const is_literal_api_key = value => Boolean(
    value && !( typeof value === `string` && /\{env:[^}]+\}/.test( value ) )
)

/**
 * Read only the provider ids from OpenCode's credential store.
 * @param {Object} [options]
 * @param {string} [options.home_dir=homedir()] - Host home directory
 * @param {Function} [options.path_exists=existsSync] - Filesystem seam
 * @param {Function} [options.read_file=readFileSync] - File reader seam
 * @returns {string[]} Authenticated provider ids without credential values
 */
export const resolve_opencode_auth_providers = ( {
    home_dir = homedir(),
    path_exists = existsSync,
    read_file = path => readFileSync( path, `utf8` ),
} = {} ) => {

    const auth_path = OPENCODE_CREDENTIAL_FILE.replace( /^~(?=\/|$)/, () => home_dir )
    if( !path_exists( auth_path ) ) return []

    try {
        const credentials = JSON.parse( read_file( auth_path ) )
        if( !credentials || typeof credentials !== `object` || Array.isArray( credentials ) ) return []

        return Object.entries( credentials )
            .filter( ( [ , credential ] ) => credential
                && typeof credential === `object`
                && typeof credential.type === `string`
            )
            .map( ( [ provider ] ) => provider )
    } catch {
        return []
    }

}

/**
 * Resolve OpenCode's configured or provider-compatible default model.
 * @param {Object} [options] - Workspace/profile context
 * @returns {string|null} Model slug, or null when OpenCode should choose
 */
export const resolve_opencode_default_model = ( options = {} ) => {

    const route = options.route || resolve_opencode_route_config( options )
    if( typeof route.model === `string` && route.model ) return route.model

    const stored_providers = resolve_opencode_auth_providers( options )
    const providers = new Set( [
        ...stored_providers,
        ...Object.keys( PROVIDER_DEFAULT_MODELS ).filter( candidate => {
            const configured_provider = route.provider?.[ candidate ]
                || route.providers?.[ candidate ]
            return is_literal_api_key( configured_provider?.options?.apiKey )
        } ),
    ] )
    const disabled_providers = new Set(
        Array.isArray( route.disabled_providers ) ? route.disabled_providers : []
    )
    const enabled_providers = Array.isArray( route.enabled_providers )
        ? route.enabled_providers
        : null
    const preferred_providers = enabled_providers
        ? enabled_providers
        : Object.keys( PROVIDER_DEFAULT_MODELS )
    const provider = preferred_providers.find( candidate =>
        providers.has( candidate )
        && PROVIDER_DEFAULT_MODELS[ candidate ]
        && !disabled_providers.has( candidate )
    )

    // Host environment keys are not forwarded into the container. Keys sourced
    // there through ~/.babysitrc, a project .env, or {env:...} config templates
    // resolve only at exec time, so leave those routes unpinned for OpenCode.
    return PROVIDER_DEFAULT_MODELS[ provider ] || null

}

/**
 * Resolve OpenCode's effective model from Babysit passthrough arguments.
 * OpenCode accepts long/short and separate/equals forms; the last flag wins.
 *
 * @param {string[]} agent_args - Arguments passed through to OpenCode
 * @param {Object} [options] - Workspace/profile context
 * @returns {string|null} Effective provider/model slug
 */
export const resolve_opencode_model = ( agent_args = [], options = {} ) => {

    const explicit_model = agent_args.reduce( ( model, argument, index ) => {
        if( [ `--model`, `-m` ].includes( argument ) ) return agent_args[ index + 1 ] || model

        const inline_model = argument.match( /^(?:--model|-m)=(.+)$/ )?.[1]
        return inline_model || model
    }, null )

    return explicit_model || resolve_opencode_default_model( options )

}

export const opencode = {

    name: `opencode`,
    bin: `opencode`,

    credentials: {
        darwin: {
            file: OPENCODE_CREDENTIAL_FILE,
        },
        linux: {
            file: OPENCODE_CREDENTIAL_FILE,
        },
    },

    // OPENCODE_CONFIG_DIR points at the config dir directly (it does NOT
    // append `.opencode` or similar). Pin to the same XDG-style location
    // opencode would pick up by default, so the global AGENTS.md and any
    // user-supplied agents/commands/modes/plugins all resolve from the
    // same root.
    home: {
        env_var: `OPENCODE_CONFIG_DIR`,
        dir: `/home/node/.config/opencode`,
    },

    container_paths: {
        creds: `/home/node/.local/share/opencode/auth.json`,
        // ${OPENCODE_CONFIG_DIR}/AGENTS.md — opencode's global instructions
        // path. Babysit bind-mounts host `~/.agents/AGENTS.md` here so
        // opencode picks up the user's cross-agent globals via its own
        // discovery. Babysit's base prompt is delivered as
        // config.initial_prompt typed into the tmux pane on launch.
        user_globals_file: `/home/node/.config/opencode/AGENTS.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        resume: ( id ) => [ `--session`, id ],
        resume_latest: () => [ `--continue` ],
        model: ( m ) => [ `--model`, m ],
        effort: null,
    },

    auth_check: {
        // .babysitrc is sourced by the entrypoint after Docker env flags. Pin
        // only the config directory at exec time so the generated tool-free
        // agent cannot be bypassed while provider/token env remains available.
        command_prefix: [
            `env`,
            `-u`, `OPENCODE_CONFIG`,
            `-u`, `OPENCODE_CONFIG_CONTENT`,
            `OPENCODE_CONFIG_DIR=/home/node/.config/opencode`,
        ],
        args: ( prompt, { agent_args = [], ...options } = {} ) => {
            const model = resolve_opencode_model( agent_args, options )

            return [
                `run`,
                ... model ? [ `--model`, model ] : [],
                `--agent`, OPENCODE_AUTH_AGENT,
                prompt,
            ]
        },
        cache_context: ( agent_args = [], options = {} ) => {
            const route = resolve_opencode_route_config( options )

            return {
                model: resolve_opencode_model( agent_args, { ...options, route } ) || `auto`,
                profile: OPENCODE_AUTH_PROFILE_VERSION,
                route: JSON.stringify( route ),
            }
        },
    },

    // Keep the launch model on the provider the user authenticated. Explicit
    // passthrough flags still win because they are appended after defaults.
    defaults: {
        model: resolve_opencode_default_model,
    },

    // OpenCode session ids are commonly `ses_...`, not UUIDs. Capture its
    // native `opencode --session <id>` resume hint as well as generic status
    // lines so Babysit does not reduce OpenCode to an imprecise --continue.
    session_id_pattern: /(?:opencode\s+.*?--session\s+|session(?:\s+id)?[:\s]+)([a-z]+_[A-Za-z0-9]+|[0-9a-f-]{36})/i,

    // OpenCode 1.18.15 shows this placeholder only after its composer accepts
    // pasted text. Provider/auth modals and model errors can leave that composer
    // visible in the background, so reject their stable headings before sending.
    initial_prompt_ready_pattern: /^(?![\s\S]*(?:Connect a provider|Select auth method|Manually enter API Key|Model .+ is not valid))[\s\S]*Ask anything\.\.\./i,

    extra_env: () => ( {} ),

    update: {
        self_update: { cmd: `opencode`, args: [ `upgrade` ] },
        npm_package: `opencode-ai`,
        brew_package: `opencode`,
    },

}
