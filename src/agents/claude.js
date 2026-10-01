/**
 * Claude Code adapter
 * CLI docs: https://code.claude.com/docs/en/cli-reference
 */
const INITIAL_PROMPT_BLOCKERS = [
    /Choose the text style/i,
    /Select (?:a )?login method/i,
    /Press Enter to continue/i,
    /Update available/i,
    /Bypass Permissions mode/i,
    /Do you trust the files in this folder/i,
]

const is_initial_prompt_ready = output => {

    const has_composer = /Claude Code v\d/i.test( output )
        && /\?\s+for shortcuts/i.test( output )
    const has_startup_blocker = INITIAL_PROMPT_BLOCKERS.some( pattern => pattern.test( output ) )

    return has_composer && !has_startup_blocker

}

// Claude Code 2.1.283 keeps its "Dangerous rm operation" check active under
// --dangerously-skip-permissions (the check is bypass-immune) and auto-denies
// it after two minutes. Captured shape, bottom of the pane:
//
//    Bash command
//      <command>
//      <description>
//    │ Dangerous rm operation on <reason>
//    ⚠ Claude Code will automatically deny this request in 1:58, …
//    Do you want to proceed?
//    ❯ 1. Yes
//      2. No
//    Esc to cancel · Tab to amend
//
// tests/e2e/claude-dangerous-dialog.js reports when this layout drifts.
export const DANGEROUS_DIALOG = {
    reason: /^\s*│?\s*(Dangerous rm(?:dir)? operation\b.*?)\s*$/,
    question: /^\s*Do you want to proceed\?\s*$/,
    approve: /^\s*❯\s*1\.\s+Yes\s*$/,
    deny: /^\s*2\.\s+No\s*$/,
    footer: /^\s*Esc to cancel\b/,
    header: /^\s*Bash command\s*$/,
}

/**
 * Find Claude's live dangerous-command dialog with its cursor on "Yes".
 * Only the pane's bottom counts: the same words in transcript history or a
 * cursor a person moved to "No" never match.
 * @param {string} screen - ANSI-free pane capture
 * @returns {{ command: string, reason: string } | null} Dialog details
 */
export const find_dangerous_command_dialog = screen => {

    const lines = screen.split( `\n` ).filter( line => line.trim() ).slice( -20 )
    const at = ( pattern, from = 0 ) => lines.findIndex( ( line, index ) => index >= from && pattern.test( line ) )

    // The dialog replaces the composer, so its footer is the last line.
    if( !DANGEROUS_DIALOG.footer.test( lines.at( -1 ) || `` ) ) return null

    const question = at( DANGEROUS_DIALOG.question )
    if( question < 0 || !DANGEROUS_DIALOG.approve.test( lines[ question + 1 ] || `` ) ) return null
    if( !DANGEROUS_DIALOG.deny.test( lines[ question + 2 ] || `` ) ) return null

    const reason_index = lines.findLastIndex( ( line, index ) => index < question && DANGEROUS_DIALOG.reason.test( line ) )
    if( reason_index < 0 ) return null

    const header = lines.findLastIndex( ( line, index ) => index < reason_index && DANGEROUS_DIALOG.header.test( line ) )
    const command = header < 0 ? `` : lines[ header + 1 ].trim().replace( /^│\s*/, `` )

    return { command, reason: lines[ reason_index ].match( DANGEROUS_DIALOG.reason )[ 1 ] }

}

export const claude = {

    name: `claude`,
    bin: `claude`,

    // Claude's version command refreshes near-expiry host credentials.
    // Other adapters omit this capability because their version commands do
    // not change authentication state.
    credential_preflight: true,

    credentials: {
        darwin: {
            keychain_service: `Claude Code-credentials`,
            fallback_file: `~/.claude/.credentials.json`,
        },
        linux: {
            file: `~/.claude/.credentials.json`,
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
        model: ( m ) => [ `--model`, m ],
        effort: ( e ) => [ `--effort`, e ],
    },

    auth_check: {
        args: prompt => [ `-p`, prompt, `--no-session-persistence` ],
    },

    defaults: {
        // `best` tracks Claude Code's strongest generally available model.
        // Start with balanced reasoning; deeper effort remains an explicit opt-in.
        model: `best`,
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
    dangerous_command_dialog: find_dangerous_command_dialog,

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
