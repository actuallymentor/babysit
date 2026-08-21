/**
 * OpenCode adapter
 * CLI docs: https://opencode.ai/docs/cli/
 */
import { resolve_opencode_route_config } from './opencode_config.js'

export const OPENCODE_DEFAULT_MODEL = `openai/gpt-5.6-sol`
export const OPENCODE_AUTH_AGENT = `babysit-auth`
export const OPENCODE_AUTH_PROFILE_VERSION = `tool-free-v1`

/**
 * Resolve OpenCode's effective model from Babysit passthrough arguments.
 * OpenCode accepts long/short and separate/equals forms; the last flag wins.
 *
 * @param {string[]} agent_args - Arguments passed through to OpenCode
 * @returns {string} Effective provider/model slug
 */
export const resolve_opencode_model = ( agent_args = [] ) => agent_args.reduce(
    ( model, argument, index ) => {
        if( [ `--model`, `-m` ].includes( argument ) ) return agent_args[ index + 1 ] || model

        const inline_model = argument.match( /^(?:--model|-m)=(.+)$/ )?.[1]
        return inline_model || model
    },
    OPENCODE_DEFAULT_MODEL
)

export const opencode = {

    name: `opencode`,
    bin: `opencode`,

    credentials: {
        darwin: {
            file: `~/.local/share/opencode/auth.json`,
        },
        linux: {
            file: `~/.local/share/opencode/auth.json`,
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
        args: ( prompt, { agent_args = [] } = {} ) => [
            `run`,
            `--model`, resolve_opencode_model( agent_args ),
            `--agent`, OPENCODE_AUTH_AGENT,
            prompt,
        ],
        cache_context: ( agent_args = [], options = {} ) => ( {
            model: resolve_opencode_model( agent_args ),
            profile: OPENCODE_AUTH_PROFILE_VERSION,
            route: JSON.stringify( resolve_opencode_route_config( options ) ),
        } ),
    },

    // Keep OpenCode on a concrete model from its current OpenAI catalog rather
    // than inheriting a provider-dependent built-in. Non-OpenAI providers override
    // via `babysit opencode --model anthropic/claude-opus-4-7`.
    defaults: {
        model: OPENCODE_DEFAULT_MODEL,
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
