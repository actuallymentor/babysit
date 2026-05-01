import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

import { copy_host_file_to_tmpfile, build_tmpfile } from '../utils/tmpfile.js'

const home = homedir()

/**
 * Claude extra mounts: settings.json (with the babysit statusline
 * override), .claude.json (with /workspace pre-trusted and onboarding
 * marked complete), and the read-only metadata files (CLAUDE.md, skills/).
 *
 * Without the .claude.json mount, claude treats every fresh container as a
 * brand-new install and pops the theme picker + workspace-trust dialog —
 * neither has a CLI flag override, so the supervised session stalls.
 *
 * @returns {{ host: string, container: string, ro?: boolean }[]}
 */
export const claude_extra_mounts = () => {

    const mounts = []

    const settings_tmpfile = build_claude_settings_tmpfile( join( home, `.claude`, `settings.json` ) )
    if( settings_tmpfile ) {
        mounts.push( { host: settings_tmpfile, container: `/home/node/.claude/settings.json` } )
    }

    const claude_json_tmpfile = build_claude_json_tmpfile( join( home, `.claude.json` ) )
    if( claude_json_tmpfile ) {
        mounts.push( { host: claude_json_tmpfile, container: `/home/node/.claude/.claude.json` } )
    }

    // Read-only metadata. Safe to mount in any mode — claude only reads them.
    const claude_md = join( home, `.claude`, `CLAUDE.md` )
    if( existsSync( claude_md ) ) {
        mounts.push( { host: claude_md, container: `/home/node/.claude/CLAUDE.md`, ro: true } )
    }

    const skills_dir = join( home, `.claude`, `skills` )
    if( existsSync( skills_dir ) ) {
        mounts.push( { host: skills_dir, container: `/home/node/.claude/skills`, ro: true } )
    }

    return mounts

}

/**
 * Build the merged settings.json claude reads inside the container.
 * Reads the host's settings.json (if any), merges in the babysit statusline
 * override, and writes the result to a chmod-666 tmpfile.
 * Exported for direct testing — the round-trip happens via `claude_extra_mounts`.
 * @param {string} host_settings_path - Path to the host's settings.json (may not exist)
 * @returns {string|null} Tmpfile path that should be bind-mounted, or null on error
 */
export const build_claude_settings_tmpfile = ( host_settings_path ) => {

    let settings = {}
    if( existsSync( host_settings_path ) ) {
        try {
            settings = JSON.parse( readFileSync( host_settings_path, `utf-8` ) ) 
        } catch { /* malformed → start fresh */ }
    }

    settings.statusLine = {
        type: `command`,
        command: `bash /usr/local/bin/statusline.sh`,
    }

    return build_tmpfile( `claude`, `settings.json`, JSON.stringify( settings, null, 2 ) )

}

// Sentinel `lastOnboardingVersion` we write into the container's .claude.json.
// Picked high enough to outpace any plausible future claude release so the
// version-delta onboarding (theme picker etc.) never triggers — see the
// onboarding-bypass comment block in `build_claude_json_tmpfile` below.
export const ONBOARDING_VERSION_SENTINEL = `9999.0.0`

/**
 * Build the .claude.json claude reads inside the container.
 *
 * Three surgical edits to the host file:
 * 1. Pre-mark `/workspace` as a trusted project so claude doesn't pop the
 *    "Quick safety check" dialog. The dialog has no CLI flag override.
 * 2. Set `hasCompletedOnboarding: true` so claude skips the theme picker
 *    on first launch even when oauthAccount is populated (which happens
 *    on a fresh container because `numStartups` resets to 1).
 * 3. Pin `lastOnboardingVersion` to a sentinel higher than any plausible
 *    future claude release. Without this, when the container's claude is
 *    newer than the host's recorded version (the Dockerfile pulls latest
 *    on every image build), claude treats it as "new version since last
 *    onboarding" and reruns the version-delta onboarding flow — which
 *    shows the theme picker again. `hasCompletedOnboarding: true` alone
 *    no longer suppresses this in claude ≥ 2.1.x.
 *
 * Exported for direct testing — the round-trip happens via `claude_extra_mounts`.
 * @param {string} host_claude_json_path - Path to host .claude.json (may not exist)
 * @returns {string|null} Tmpfile path that should be bind-mounted, or null
 */
export const build_claude_json_tmpfile = ( host_claude_json_path ) => {

    let parsed = {}
    if( existsSync( host_claude_json_path ) ) {
        try {
            parsed = JSON.parse( readFileSync( host_claude_json_path, `utf-8` ) )
        } catch { /* malformed → start fresh */ }
    }

    // Mirror the shape claude writes for any project it has seen before.
    parsed.projects = parsed.projects || {}
    const existing = parsed.projects[ `/workspace` ] || {}
    parsed.projects[ `/workspace` ] = {
        ...existing,
        allowedTools: existing.allowedTools || [],
        mcpContextUris: existing.mcpContextUris || [],
        mcpServers: existing.mcpServers || {},
        enabledMcpjsonServers: existing.enabledMcpjsonServers || [],
        disabledMcpjsonServers: existing.disabledMcpjsonServers || [],
        hasTrustDialogAccepted: true,
        projectOnboardingSeenCount: 1,
        hasClaudeMdExternalIncludesApproved: false,
        hasClaudeMdExternalIncludesWarningShown: false,
    }

    parsed.hasCompletedOnboarding = true
    parsed.lastOnboardingVersion = ONBOARDING_VERSION_SENTINEL

    return build_tmpfile( `claude`, `.claude.json`, JSON.stringify( parsed, null, 2 ) )

}

// Recent codex model versions that codex shows a one-time "new model
// available" intro for. Fresh containers re-trigger these every session
// because their state lives in config.toml, which we mount as a tmpfile
// snapshot. We pre-mark each one as "seen" (count >= 1) so the dialog
// never appears. New versions can be appended here as codex ships them.
export const CODEX_KNOWN_MODELS_FOR_NUX = [ `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-5.5-codex` ]

/**
 * Codex extra mounts. Codex stores per-directory trust in
 * ~/.codex/config.toml under `[projects."<path>"] trust_level = "trusted"`.
 * Without an entry for /workspace, codex shows a "Do you trust the contents
 * of this directory?" dialog on every fresh container that the user has to
 * click through. We copy the host's config.toml and add /workspace.
 *
 * We also pre-mark recent models as "seen" in `[tui.model_availability_nux]`
 * so codex doesn't pop the "Try new model" intro on launch — that dialog
 * has no flag override and would otherwise stall the supervised session.
 *
 * @returns {{ host: string, container: string }[]}
 */
export const codex_extra_mounts = () => {

    const host_config = join( home, `.codex`, `config.toml` )
    const raw = existsSync( host_config ) ? readFileSync( host_config, `utf-8` ) : ``
    const tmpfile = build_tmpfile( `codex`, `config.toml`, inject_codex_first_run_bypass( raw ) )

    const mounts = []
    if( tmpfile ) mounts.push( { host: tmpfile, container: `/home/node/.codex/config.toml` } )

    // NOTE: do NOT mount the host's installation_id. Mounting it breaks
    // codex's session machinery with "Failed to create session: Operation
    // not permitted" — see GOTCHAS.md #33. Regression test in
    // tests/setup.test.js asserts this exclusion.

    return mounts

}

/**
 * Inject the "trust /workspace" + "model nux seen" entries into a codex
 * config.toml. Idempotent: re-running on output of itself produces the
 * same string. Works on an empty input (fresh-install case).
 */
const inject_codex_first_run_bypass = ( raw ) => {

    let out = raw

    if( !out.includes( `[projects."/workspace"]` ) ) {
        out += `\n\n[projects."/workspace"]\ntrust_level = "trusted"\n`
    }

    const has_nux_section = /\[tui\.model_availability_nux\]/.test( out )
    const missing = CODEX_KNOWN_MODELS_FOR_NUX.filter(
        m => !new RegExp( `"${ m.replace( /\./g, `\\.` ) }"\\s*=` ).test( out )
    )
    if( missing.length ) {
        const lines = missing.map( m => `"${ m }" = 2` ).join( `\n` )
        if( has_nux_section ) {
            out = out.replace( /\[tui\.model_availability_nux\]\n/, `[tui.model_availability_nux]\n${ lines }\n` )
        } else {
            out += `\n\n[tui.model_availability_nux]\n${ lines }\n`
        }
    }

    return out

}

/**
 * Gemini extra mounts. Gemini's "logged in" state lives across several files
 * in ~/.gemini/, not just oauth_creds.json. Without settings.json (which
 * carries `auth.selectedType`) gemini drops into its auth-method picker on
 * launch, ignoring the OAuth tokens it has on disk. trustedFolders.json
 * needs /workspace to skip the trust dialog.
 *
 * @returns {{ host: string, container: string }[]}
 */
export const gemini_extra_mounts = () => {

    const mounts = []
    const gemini_dir = join( home, `.gemini` )

    // Files we copy 1:1 (with chmod 666 so gemini can update them in-container).
    const passthrough = [ `settings.json`, `google_accounts.json`, `installation_id`, `state.json` ]
    for( const file of passthrough ) {
        const tmp = copy_host_file_to_tmpfile( join( gemini_dir, file ), `gemini` )
        if( tmp ) mounts.push( { host: tmp, container: `/home/node/.gemini/${ file }` } )
    }

    // trustedFolders.json — merge /workspace into whatever the host has, or
    // create the file fresh if missing. The host's entries refer to host paths
    // (/home/sandbox/...) which don't apply inside the container; /workspace
    // is the only path the container actually sees.
    const host_trust = join( gemini_dir, `trustedFolders.json` )
    let trust_obj = {}
    if( existsSync( host_trust ) ) {
        try {
            trust_obj = JSON.parse( readFileSync( host_trust, `utf-8` ) ) 
        } catch { /* malformed → start fresh */ }
    }
    trust_obj[ `/workspace` ] = `TRUST_FOLDER`
    const trust_tmpfile = build_tmpfile( `gemini`, `trustedFolders.json`, JSON.stringify( trust_obj, null, 2 ) )
    if( trust_tmpfile ) mounts.push( { host: trust_tmpfile, container: `/home/node/.gemini/trustedFolders.json` } )

    return mounts

}

/**
 * Opencode extra mounts. Opencode's auth.json is already handled by the
 * credentials module; opencode keeps the rest of its state in
 * ~/.local/share/opencode (a sqlite DB) but those are session-scoped and
 * don't need to be copied into the container.
 *
 * @returns {{ host: string, container: string }[]}
 */
export const opencode_extra_mounts = () => []

const NO_EXTRA_MOUNTS = () => []

const EXTRA_MOUNTS_BY_AGENT = {
    claude: claude_extra_mounts,
    codex: codex_extra_mounts,
    gemini: gemini_extra_mounts,
    opencode: opencode_extra_mounts,
}

/**
 * Look up the extra mounts builder for a given agent.
 * @param {string} agent_name
 * @returns {() => { host: string, container: string, ro?: boolean }[]}
 */
export const get_extra_mounts = ( agent_name ) => EXTRA_MOUNTS_BY_AGENT[ agent_name ] || NO_EXTRA_MOUNTS
