import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse as parse_toml, stringify as stringify_toml } from 'smol-toml'

import {
    build_private_tmpfile,
    build_tmpdir_with_files,
    build_tmpfile,
    copy_host_file_to_tmpfile,
} from '../utils/tmpfile.js'
import { expand_home_path } from '../credentials/paths.js'
import { get_host_codex_home } from './codex.js'
import { OPENCODE_AUTH_AGENT } from './opencode.js'
import { resolve_opencode_route_config } from './opencode_config.js'
import { add_completion_hooks, completion_capture_mounts } from './completion_capture.js'

const home = homedir()

// Cross-agent shared dir on the host. ~/.agents/AGENTS.md (user globals) and
// ~/.agents/skills/ (cross-agent skills) take precedence over per-agent
// equivalents like ~/.claude/CLAUDE.md and ~/.claude/skills/, since the
// shared paths reach all four agents while the claude-specific ones only
// reach claude.
const AGENTS_DIR = join( home, `.agents` )

/**
 * Claude extra mounts: settings.json (with the babysit statusline
 * override), .claude.json (with /workspace pre-trusted and onboarding
 * marked complete), and the read-only metadata files (CLAUDE.md, skills/).
 *
 * Without the .claude.json mount, claude treats every fresh container as a
 * brand-new install and pops the theme picker + workspace-trust dialog —
 * neither has a CLI flag override, so the supervised session stalls.
 *
 * @param {Object} [options]
 * @param {boolean} [options.yolo=false] - Persist `skipDangerousModePermissionPrompt: true`
 *   in the merged settings tmpfile so claude doesn't show the "Bypass Permissions
 *   mode" warning at every `--dangerously-skip-permissions` launch.
 * @param {boolean} [options.include_host_preferences=true] - Copy host agent preferences
 * @param {boolean} [options.auth_probe=false] - Omit instructions and skills from auth probes
 * @returns {{ host: string, container: string, ro?: boolean }[]}
 */
export const claude_extra_mounts = ( {
    yolo = false,
    include_host_preferences = true,
    auth_probe = false,
    completion_capture = null,
} = {} ) => {

    const mounts = []

    const settings_tmpfile = build_claude_settings_tmpfile(
        join( home, `.claude`, `settings.json` ),
        { yolo, include_host_preferences, completion_capture }
    )
    if( settings_tmpfile ) {
        mounts.push( { host: settings_tmpfile, container: `/home/node/.claude/settings.json` } )
    }

    const claude_json_tmpfile = build_claude_json_tmpfile( join( home, `.claude.json` ), {
        include_host_preferences,
    } )
    if( claude_json_tmpfile ) {
        mounts.push( { host: claude_json_tmpfile, container: `/home/node/.claude/.claude.json` } )
    }

    // Read-only metadata. Safe to mount in any mode — claude only reads them.
    // ~/.agents/AGENTS.md (cross-agent globals) wins over ~/.claude/CLAUDE.md
    // when both exist on the host: run.js mounts the shared file at the same
    // container target, so adding the per-agent file here would collide.
    // Same logic for skills/ — ~/.agents/skills/ is the cross-agent
    // convention; the entrypoint symlinks it into place when present.
    const shared_agents_md = join( AGENTS_DIR, `AGENTS.md` )
    if( !auth_probe && include_host_preferences && !existsSync( shared_agents_md ) ) {
        const claude_md = join( home, `.claude`, `CLAUDE.md` )
        if( existsSync( claude_md ) ) {
            mounts.push( { host: claude_md, container: `/home/node/.claude/CLAUDE.md`, ro: true } )
        }
    }

    const shared_skills = join( AGENTS_DIR, `skills` )
    if( !auth_probe && include_host_preferences && !existsSync( shared_skills ) ) {
        const skills_dir = join( home, `.claude`, `skills` )
        if( existsSync( skills_dir ) ) {
            mounts.push( { host: skills_dir, container: `/home/node/.claude/skills`, ro: true } )
        }
    }

    return mounts

}

/**
 * Build the merged settings.json claude reads inside the container.
 * Reads the host's settings.json (if any), merges in the babysit statusline
 * override, and writes the result to a chmod-666 tmpfile.
 * Exported for direct testing — the round-trip happens via `claude_extra_mounts`.
 *
 * In yolo mode we also persist `skipDangerousModePermissionPrompt: true` so
 * claude doesn't show the "Bypass Permissions mode" warning dialog on every
 * `--dangerously-skip-permissions` launch. The user already opted in via
 * `--yolo`; the merged file lives only inside the container, so the host's
 * settings.json is untouched.
 *
 * @param {string} host_settings_path - Path to the host's settings.json (may not exist)
 * @param {Object} [options]
 * @param {boolean} [options.yolo=false] - When true, suppress the bypass-permissions warning
 * @param {boolean} [options.include_host_preferences=true] - Merge the host settings file
 * @returns {string|null} Tmpfile path that should be bind-mounted, or null on error
 */
export const build_claude_settings_tmpfile = ( host_settings_path, {
    yolo = false,
    include_host_preferences = true,
    completion_capture = null,
} = {} ) => {

    let settings = {}
    if( include_host_preferences && existsSync( host_settings_path ) ) {
        try {
            settings = JSON.parse( readFileSync( host_settings_path, `utf-8` ) )
        } catch { /* malformed → start fresh */ }
    }

    settings.statusLine = {
        type: `command`,
        command: `bash /usr/local/bin/statusline.sh`,
    }

    // Top-level key (NOT nested under `permissions`). Suppresses the
    // "WARNING: Claude Code running in Bypass Permissions mode" dialog
    // that otherwise fires on every `--dangerously-skip-permissions` launch.
    if( yolo ) settings.skipDangerousModePermissionPrompt = true

    if( completion_capture ) add_completion_hooks( settings, `claude` )

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
 * @param {Object} [options]
 * @param {boolean} [options.include_host_preferences=true] - Merge host onboarding and project state
 * @returns {string|null} Tmpfile path that should be bind-mounted, or null
 */
export const build_claude_json_tmpfile = ( host_claude_json_path, {
    include_host_preferences = true,
} = {} ) => {

    let parsed = {}
    if( include_host_preferences && existsSync( host_claude_json_path ) ) {
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
// because their state lives in config.toml, which we mount in a tmpdir
// snapshot. We pre-mark each one as "seen" (count >= 1) so the dialog
// never appears. New versions can be appended here as codex ships them.
export const CODEX_KNOWN_MODELS_FOR_NUX = [ `gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5.3`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.5`, `gpt-5.5-codex`, `gpt-5.6`, `gpt-5.6-sol`, `gpt-6-astra` ]

/**
 * Inject the "trust /workspace" + "model nux seen" entries into a codex
 * config.toml, plus disable the `apps` feature flag (which spawns the
 * codex_apps MCP). Idempotent: re-running on output of itself produces
 * the same string. Works on an empty input (fresh-install case).
 *
 * Why `apps = false`: codex_apps connects to OpenAI's hosted Drive/Slides/
 * etc connectors via an MCP transport that demands a fresh OAuth access
 * token at every codex startup. Babysit pre-flight refreshes the codex CLI
 * token but cannot force a refresh of the access token used by codex_apps
 * (codex exposes no CLI command for it), so containers spawned more than
 * an hour after the user's last host-side codex run reliably emit a noisy
 * "MCP client for codex_apps failed to start: token_expired" warning. The
 * connectors are also useless in a sandboxed coding-agent context — the
 * babysit container has no Google Drive workflow — so we disable the
 * feature outright via `[features] apps = false` (equivalent to passing
 * `--disable apps` to codex). Run `codex features list` to see all flags.
 */
const inject_codex_first_run_bypass = ( raw ) => {

    let config
    try {
        // Preserve integer/float types and large integers in the temporary copy.
        config = parse_toml( raw, { integersAsBigInt: true } )
    } catch ( error ) {
        // Parser messages include source excerpts, which may contain secrets.
        throw new Error( `Invalid Codex config.toml at line ${ error.line }, column ${ error.column }. Fix the host configuration before launching.` )
    }

    const table = ( parent, key ) => {
        parent[key] ??= {}
        if( typeof parent[key] !== `object` || Array.isArray( parent[key] ) || parent[key] instanceof Date ) {
            throw new Error( `Invalid Codex config.toml: '${ key }' must be a table.` )
        }
        return parent[key]
    }

    // Rebuild only the container snapshot. Native TOML can use bare, quoted,
    // dotted, or inline keys; text matching cannot reliably identify duplicates.
    config.check_for_update_on_startup = false
    const projects = table( config, `projects` )
    projects[`/workspace`] ??= { trust_level: `trusted` }
    const nux = table( table( config, `tui` ), `model_availability_nux` )
    CODEX_KNOWN_MODELS_FOR_NUX.forEach( model => {
        nux[model] ??= 2n
    } )

    const features = table( config, `features` )
    features.apps ??= false

    const output = stringify_toml( config, { numbersAsFloat: true } )
    // Fail before staging a file if serialization ever produces invalid TOML.
    parse_toml( output, { integersAsBigInt: true } )
    return output

}

/**
 * Build the temporary Codex config directory mounted as CODEX_HOME.
 * @param {string} raw_config - Host config.toml content, or empty string
 * @param {Object} [options]
 * @param {string} [options.user_globals_path] - Host ~/.agents/AGENTS.md path
 * @param {boolean} [options.include_host_preferences=true] - Copy host config and globals
 * @param {boolean} [options.include_user_globals=true] - Copy global instructions
 * @returns {{ tmpdir: string|null, provides_user_globals: boolean }}
 */
export const build_codex_config_tmpdir = ( raw_config, {
    user_globals_path = join( AGENTS_DIR, `AGENTS.md` ),
    include_host_preferences = true,
    include_user_globals = true,
} = {} ) => {

    const files = {
        [`config.toml`]: inject_codex_first_run_bypass( include_host_preferences ? raw_config : `` ),
    }

    const provides_user_globals = include_host_preferences
        && include_user_globals
        && existsSync( user_globals_path )
    if( provides_user_globals ) files[`AGENTS.md`] = readFileSync( user_globals_path, `utf-8` )

    return {
        tmpdir: build_tmpdir_with_files( `codex`, `config`, files ),
        provides_user_globals,
    }

}

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
 * Because Codex needs the whole CODEX_HOME directory mounted writable for
 * atomic config.toml saves, ~/.agents/AGENTS.md is copied into that tmpdir
 * instead of mounted as a second nested bind. Docker Desktop rejects creating
 * a nested file mount inside the tmpdir-backed CODEX_HOME mount.
 *
 * @param {Object} [options]
 * @param {boolean} [options.include_host_preferences=true] - Copy host Codex config and globals
 * @param {boolean} [options.auth_probe=false] - Keep provider config but omit instructions
 * @returns {{ host: string, container: string, provides_user_globals?: boolean }[]}
 */
export const codex_extra_mounts = ( {
    include_host_preferences = true,
    auth_probe = false,
} = {} ) => {

    const host_config = join( expand_home_path( get_host_codex_home() ), `config.toml` )
    const raw = include_host_preferences && existsSync( host_config )
        ? readFileSync( host_config, `utf-8` )
        : ``
    const { tmpdir, provides_user_globals } = build_codex_config_tmpdir( raw, {
        include_host_preferences,
        include_user_globals: !auth_probe,
    } )

    const mounts = []
    if( tmpdir ) mounts.push( { host: tmpdir, container: `/home/node/.codex`, provides_user_globals } )

    // NOTE: do NOT mount the host's installation_id. Mounting it breaks
    // codex's session machinery with "Failed to create session: Operation
    // not permitted" — see GOTCHAS.md #33. Regression test in
    // tests/setup.test.js asserts this exclusion.

    return mounts

}

/**
 * Stage Antigravity preferences separately from its persistent conversation state.
 * Profile isolation retains only provider selection; hooks are launch-scoped.
 * @param {Object} [options] - Host preference, probe, and completion options
 * @param {string} [options.antigravity_dir] - Native host CLI state directory
 * @param {string} [options.config_dir] - Shared Antigravity customization directory
 * @returns {Object[]} Writable container seed files
 */
export const antigravity_extra_mounts = ( {
    include_host_preferences = true,
    antigravity_dir = join( home, `.gemini`, `antigravity-cli` ),
    config_dir = join( home, `.gemini`, `config` ),
    auth_probe = false,
    completion_capture = null,
} = {} ) => {

    const mounts = []
    const settings = build_antigravity_settings_tmpfile( join( antigravity_dir, `settings.json` ), { include_host_preferences } )
    if( settings ) mounts.push( { host: settings, container: `/home/node/.gemini/antigravity-cli/settings.json` } )

    // Completed native onboarding includes account consent. Carry the user's
    // existing choice even when omitting visual preferences; never invent it.
    if( !auth_probe ) {
        const path = join( antigravity_dir, `cache`, `onboarding.json` )
        let onboarding = null
        try {
            onboarding = JSON.parse( readFileSync( path, `utf8` ) )
        } catch { /* No completed host onboarding to carry. */ }
        // An unfinished host wizard must not reset consent completed in the
        // persistent Babysit state during an earlier container launch.
        if( onboarding && typeof onboarding === `object` && !Array.isArray( onboarding ) && onboarding.onboardingComplete === true ) {
            const tmp = build_tmpfile( `antigravity`, `onboarding.json`, JSON.stringify( onboarding, null, 2 ) )
            if( tmp ) mounts.push( { host: tmp, container: `/home/node/.gemini/antigravity-cli/cache/onboarding.json` } )
        }
    }

    // Keep provider/customization state out of the conversation volume. Seed
    // copies are writable and never let native migrations modify host files.
    if( include_host_preferences && !auth_probe ) {
        for( const file of [ `config.json`, `mcp_config.json` ] ) {
            const tmp = copy_host_file_to_tmpfile( join( config_dir, file ), `antigravity` )
            if( tmp ) mounts.push( { host: tmp, container: `/home/node/.gemini/config/${ file }` } )
        }
    }

    let hooks = {}
    const host_hooks = join( config_dir, `hooks.json` )
    if( include_host_preferences && !auth_probe && existsSync( host_hooks ) ) {
        try {
            hooks = JSON.parse( readFileSync( host_hooks, `utf8` ) )
        } catch { /* Ignore malformed host hooks. */ }
    }
    if( !hooks || typeof hooks !== `object` || Array.isArray( hooks ) ) hooks = {}
    if( completion_capture && !auth_probe ) add_completion_hooks( hooks, `antigravity` )
    const hooks_file = build_tmpfile( `antigravity`, `hooks.json`, JSON.stringify( hooks, null, 2 ) )
    if( hooks_file ) mounts.push( { host: hooks_file, container: `/home/node/.gemini/config/hooks.json` } )

    return mounts

}

/**
 * Preserve API-provider selection when omitting host UI and tool preferences.
 * @param {string} host_settings_path - Native Antigravity settings file
 * @param {Object} [options]
 * @param {boolean} [options.include_host_preferences=true] - Copy host preferences
 * @returns {string|null} Temporary container settings file
 */
export const build_antigravity_settings_tmpfile = ( host_settings_path, {
    include_host_preferences = true,
} = {} ) => {

    let settings = {}
    if( existsSync( host_settings_path ) ) {
        try {
            settings = JSON.parse( readFileSync( host_settings_path, `utf8` ) )
        } catch { /* Start with native defaults. */ }
    }
    if( !settings || typeof settings !== `object` || Array.isArray( settings ) ) settings = {}
    if( !include_host_preferences ) settings = settings.modelProvider === `gemini` ? { modelProvider: `gemini` } : {}
    if( process.env.GEMINI_API_KEY ) settings.modelProvider = `gemini`

    return build_tmpfile( `antigravity`, `settings.json`, JSON.stringify( settings, null, 2 ) )

}

/**
 * OpenCode extra mounts. Both normal sessions and auth probes receive the same
 * sanitized provider/model route snapshot. Probes add one generated primary
 * agent with every tool disabled. This keeps the request useful as an auth
 * check without asking a fallback model to parse unsupported tool schemas.
 *
 * @param {Object} [options]
 * @param {boolean} [options.auth_probe=false] - Generate a tool-free probe agent
 * @param {boolean} [options.include_host_preferences=true] - Include host route config
 * @param {string} [options.workspace=process.cwd()] - Active project directory
 * @returns {{ host: string, container: string }[]}
 */
export const opencode_extra_mounts = ( {
    auth_probe = false,
    include_host_preferences = true,
    workspace = process.cwd(),
} = {} ) => {

    const route = resolve_opencode_route_config( {
        workspace,
        include_host_preferences,
    } )
    if( !auth_probe && !Object.keys( route ).length ) return []

    const profile = {
        ...route,
        ...auth_probe ? {
            agent: {
                [ OPENCODE_AUTH_AGENT ]: {
                    mode: `primary`,
                    permission: `deny`,
                    tools: { '*': false },
                },
            },
        } : {},
    }
    const transport = build_private_tmpfile(
        `opencode`,
        `opencode.json`,
        `${ JSON.stringify( profile, null, 2 ) }\n`,
        { file_mode: 0o644 }
    )
    if( !transport ) return []

    return [ {
        host: transport.file,
        container: `/home/node/.config/opencode/opencode.json`,
        type: `seed_file`,
        source: transport.file,
        target: `/home/node/.config/opencode/opencode.json`,
        cleanup: transport.directory,
    } ]

}

const NO_EXTRA_MOUNTS = () => []

const EXTRA_MOUNTS_BY_AGENT = {
    claude: claude_extra_mounts,
    codex: codex_extra_mounts,
    antigravity: antigravity_extra_mounts,
    opencode: opencode_extra_mounts,
}

/**
 * Look up the extra mounts builder for a given agent. The returned function
 * accepts an options object that adapters can use for mode-dependent behaviour
 * (currently: claude reads `yolo` to suppress the bypass-permissions warning,
 * and all builders honor `include_host_preferences`).
 * Adapters that don't care about options ignore them.
 * @param {string} agent_name
 * @returns {(options?: { yolo?: boolean, include_host_preferences?: boolean, auth_probe?: boolean, workspace?: string }) => { host: string, container: string, ro?: boolean }[]}
 */
export const get_extra_mounts = ( agent_name ) => ( options = {} ) => {

    const build_mounts = EXTRA_MOUNTS_BY_AGENT[ agent_name ] || NO_EXTRA_MOUNTS
    const mounts = build_mounts( { ...options, completion_capture: options.auth_probe ? null : options.completion_capture } )
    if( options.completion_capture && !options.auth_probe ) mounts.push( ...completion_capture_mounts( agent_name ) )
    return mounts

}
