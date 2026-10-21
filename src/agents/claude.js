/**
 * Claude Code adapter
 * CLI docs: https://code.claude.com/docs/en/cli-reference
 */
import { homedir } from 'os'
import { join, resolve } from 'path'

// A probe with this much access left uses the token as is, so it cannot
// rotate a refresh token that a running session holds too
const REFRESH_MARGIN_MS = 10 * 60_000

const oauth_field = ( credential, key ) => {
    try {
        return Number( JSON.parse( credential )?.claudeAiOauth?.[ key ] ) || NaN
    } catch {
        return NaN
    }
}

// A relocated config dir holds other credentials than the ones Babysit stages
const uses_default_config_dir = ( env = process.env ) => !env.CLAUDE_CONFIG_DIR
    || resolve( env.CLAUDE_CONFIG_DIR.replace( /^~(?=$|\/)/, env.HOME || homedir() ) ) === join( env.HOME || homedir(), `.claude` )
const INITIAL_PROMPT_BLOCKERS = [
    /Choose the text style/i,
    /Select (?:a )?login method/i,
    /Press Enter to continue/i,
    /Update available/i,
    /Bypass Permissions mode/i,
    /Do you trust the files in this folder/i,
]

// Claude Code <=2.1.28x shows "? for shortcuts" under an idle composer; 2.1.287+
// replaced it with the permission-mode footer "⏵⏵ auto mode on (shift+tab to cycle)".
const COMPOSER_FOOTERS = [ /\?\s+for shortcuts/i, /shift\+tab to cycle/i ]

const is_initial_prompt_ready = output => {

    const has_composer = /Claude Code v\d/i.test( output )
        && COMPOSER_FOOTERS.some( pattern => pattern.test( output ) )
    const has_startup_blocker = INITIAL_PROMPT_BLOCKERS.some( pattern => pattern.test( output ) )

    return has_composer && !has_startup_blocker

}

// YOLO answers any Claude prompt that still stops a --dangerously-skip-permissions
// session (bypass-immune rm checks, unchecked shell -c scripts, folder trust, …)
// by accepting its default, when that default is a plain yes. Matched by shape,
// not wording, so new prompt variants need no code change:
//
//    <question ending in ?>
//    ❯ 1. Yes                 ← cursor already on an approving answer
//      2. No
//    Esc to cancel · …        ← last line: the dialog owns the pane bottom
//
// Never answered for the user: model swaps (fallback/usage-limit offers),
// billing, and prompts raised by a person's own deny rule.
//
// tests/e2e/claude-dangerous-dialog.js reports when this layout drifts.
export const YOLO_DIALOG = {
    footer: /\bEsc to (?:cancel|exit)\b/,
    option: /^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/,
    question: /\?\s*$/,
    approve: /^(?:Yes|Continue|Accept|Allow|Approve|Proceed|Confirm|OK|Trust)\b/i,
    veto: /\b(?:models?|fallback|opus|sonnet|haiku|fable|downgrade|api key|billing|credits?|extra usage|purchase|upgrade|subscribe|pay)\b/i,
    denied: /A permission rule denies/,
    rule: /^\s*─{4,}\s*$/,
}

/**
 * Find a live Claude dialog YOLO may accept: its default answer is a plain yes.
 * Only the pane's bottom counts: the same words in transcript history, or a
 * cursor a person moved elsewhere, never match.
 * @param {string} screen - ANSI-free pane capture
 * @returns {{ title: string, question: string, answer: string } | null} Dialog details
 */
export const find_yolo_dialog = screen => {

    const lines = screen.split( `\n` ).filter( line => line.trim() ).slice( -40 )
    if( !YOLO_DIALOG.footer.test( lines.at( -1 ) || `` ) ) return null

    // Options stack directly on the footer; the question sits directly on them.
    // Anchoring on the bottom keeps history from supplying any of them.
    let top = lines.length - 1
    while( top > 0 && YOLO_DIALOG.option.test( lines[ top - 1 ] ) ) top--
    const options = lines.slice( top, -1 ).map( line => line.match( YOLO_DIALOG.option ) )
    const question = lines[ top - 1 ]?.trim() || ``
    if( options.length < 2 || !YOLO_DIALOG.question.test( question ) ) return null
    if( options.some( ( option, index ) => Number( option[ 2 ] ) !== index + 1 ) ) return null

    // The default must already approve, and nothing may hand over a model or money
    const selected = options.filter( option => option[ 1 ] )
    const answer = selected[ 0 ]?.[ 3 ] || ``
    if( selected.length !== 1 || !YOLO_DIALOG.approve.test( answer ) ) return null
    if( [ question, ...options.map( option => option[ 3 ] ) ].some( text => YOLO_DIALOG.veto.test( text ) ) ) return null

    // A person's deny rule matched: never approve on their behalf
    const opened = lines.findLastIndex( ( line, index ) => index < top && YOLO_DIALOG.rule.test( line ) )
    const body = lines.slice( opened + 1, top - 1 )
    if( body.some( line => YOLO_DIALOG.denied.test( line ) ) ) return null

    return { title: body[ 0 ]?.trim() || ``, question, answer }

}

export const claude = {

    name: `claude`,
    bin: `claude`,

    // Claude's version command refreshes near-expiry host credentials.
    // Other adapters omit this capability because their version commands do
    // not change authentication state.
    credential_preflight: true,

    // CLAUDE_CODE_OAUTH_TOKEN is the one-year `claude setup-token` login. It
    // outranks the /login file and never rotates, so sessions cannot race
    // each other for a one-use refresh token. It only makes model requests.
    credentials: {
        darwin: {
            keychain_service: `Claude Code-credentials`,
            fallback_file: `~/.claude/.credentials.json`,
            env_key: `CLAUDE_CODE_OAUTH_TOKEN`,
        },
        linux: {
            file: `~/.claude/.credentials.json`,
            env_key: `CLAUDE_CODE_OAUTH_TOKEN`,
        },
    },

    // CLAUDE_CONFIG_DIR controls where claude reads its config / credentials /
    // sessions from. We already mount our host-derived state under
    // /home/node/.claude inside the container, so pin the env var to that
    // path — this also prevents a stray host CLAUDE_CONFIG_DIR from leaking
    // through and redirecting claude to an unmounted location.
    home: {
        env_var: `CLAUDE_CONFIG_DIR`,
        dir: `/home/node/.claude`,
    },

    container_paths: {
        creds: `/home/node/.claude/.credentials.json`,
        config: `/home/node/.claude/settings.json`,
        // Claude reads ~/.claude/CLAUDE.md as global context. Babysit
        // bind-mounts host `~/.agents/AGENTS.md` here so claude picks up
        // the user's cross-agent globals via its own discovery. Babysit's
        // base prompt is delivered separately as config.initial_prompt typed
        // into the tmux pane on launch.
        user_globals_file: `/home/node/.claude/CLAUDE.md`,
    },

    flags: {
        skip_permissions: () => `--dangerously-skip-permissions`,
        resume: ( id ) => [ `--resume`, id ],
        resume_latest: () => [ `--continue` ],
        // Branch a copy of the conversation under a new session id (babysit fork)
        fork: ( id ) => [ `--resume`, id, `--fork-session` ],
        model: ( m ) => [ `--model`, m ],
        effort: ( e ) => [ `--effort`, e ],
    },

    // A subscription limit stopped the session. Rendered by 2.1.304 against a
    // fake 429 (tests/fixtures/claude/usage-limit-*.txt): `You've hit your
    // ${ session | weekly | Opus | Sonnet | Fable } limit · resets 3pm`, the
    // bare `You've hit your limit · resets 3pm` when the claim is anything
    // else (overage, none), and the auto-wait status, which Claude prefixes
    // with `●` or `⚠`: `● Usage limit reached · continuing automatically …`.
    // A model limit (Opus) opens a picker whose height pushes that line out of
    // the scanned tail, so its `Stop and wait for limit to reset` row counts too.
    // Older builds: `5-hour limit reached ∙ resets 3pm` / `Claude usage limit reached`.
    // Spend caps (monthly, usage credits) are not account quotas: excluded.
    limit_pattern: /You[’']ve hit your (?:session|weekly|Opus|Sonnet|Fable) limit\b|You[’']ve hit your limit · resets\b|\b(?:5-hour|weekly|Opus) limit reached\b|Claude (?:AI )?usage limit reached\b|^[\s●⚠]*Usage limit reached(?: again)?\b|^[\s❯]*\d\. Stop and wait for limit to reset\b/m,

    auth_check: {
        args: prompt => [ `-p`, prompt, `--no-session-persistence` ],

        // Host probe: the user's own CLI with every customization (CLAUDE.md,
        // hooks, plugins, MCP) and every tool off. `--tools ""` stays last:
        // it is variadic.
        host_args: ( prompt, { env } = {} ) => uses_default_config_dir( env )
            ? [ `-p`, prompt, `--no-session-persistence`, `--safe-mode`, `--strict-mcp-config`, `--tools`, `` ]
            : null,

        // Logged-out phrasings the generic patterns miss, captured from real
        // runs. Also the pane trigger for a running session.
        failure_pattern: /Please run \/login|Failed to authenticate|authentication_error|OAuth (?:session|token) (?:has )?(?:expired|been revoked)/i,

        refresh_free: ( credential, now = Date.now() ) => oauth_field( credential, `expiresAt` ) - now > REFRESH_MARGIN_MS,

        // Past this the login is gone, no network needed to know it
        refresh_expires_at: credential => oauth_field( credential, `refreshTokenExpiresAt` ),
    },

    defaults: {
        // `default` is Claude Code's recommended everyday model (Opus 5.5 today).
        // `best` (Fable) has its own much smaller weekly cap and, at medium
        // effort, benchmarks below Opus 5.5 at twice the cost; keep it opt-in.
        // Start with balanced reasoning; deeper effort remains an explicit opt-in.
        model: `default`,
        effort: `medium`,
    },

    // Pattern to capture the session ID from claude's output. The TUI can show
    // either a status-style "Session ID: ..." line or a ready-to-paste
    // `claude --resume ...` command when it exits.
    session_id_pattern: /(?:claude\s+(?:--resume|-r)\s+|session(?:\s+id)?[:\s]+)([0-9a-f-]{36})/i,

    // Claude prints its version on the splash before its composer exists.
    // First-run/theme/trust screens reuse the splash and consume Enter too.
    // The shortcuts footer appears only with the interactive composer.
    initial_prompt_ready: is_initial_prompt_ready,

    // YOLO monitors answer this bypass-immune prompt with Enter on "Yes".
    yolo_dialog: find_yolo_dialog,

    /**
     * Get extra environment variables for this agent
     * @returns {Object} Environment variables
     */
    extra_env: () => ( {
        DISABLE_AUTOUPDATER: `1`,
    } ),

    // Per-agent update strategies for the host-installed CLI. Tried in order:
    // built-in self-update → npm global install → brew. The runner detects the
    // install method from the binary's resolved path before invoking the
    // package-manager strategies, so an npm-installed agent never accidentally
    // triggers brew (and vice versa).
    update: {
        self_update: { cmd: `claude`, args: [ `update` ] },
        npm_package: `@anthropic-ai/claude-code`,
        // claude on Homebrew is a cask, not a formula — `brew upgrade --cask`
        // is the right invocation. `brew_cask: true` flips the args shape.
        brew_package: `claude-code`,
        brew_cask: true,
    },

}
