import { existsSync, chmodSync, mkdirSync, accessSync, constants as fs_constants } from 'fs'
import { dirname, join } from 'path'
import { tmpdir, platform, arch, homedir } from 'os'
import { fileURLToPath } from 'url'
import { promise_timeout } from 'mentie'

import pkg from '../../package.json' with { type: 'json' }

import { command_exists, run } from '../utils/exec.js'
import { AGENTS_DIR } from '../utils/paths.js'
import { get_image_name } from '../docker/update.js'
import { SUPPORTED_AGENTS, get_agent } from '../agents/index.js'
import { build_update_strategies } from '../deps/agent_update.js'

// Same budget per step as the pre-flight self-update — keeps a hung remote
// from holding the user hostage. See src/deps/selfupdate.js.
const STEP_TIMEOUT_MS = 15_000
const BINARY_DOWNLOAD_TIMEOUT_MS = 120_000
const DOCKER_PULL_TIMEOUT_MS = 120_000

// GitHub release source for compiled binaries (matches scripts/install.sh).
const GITHUB_REPO = `actuallymentor/babysit`
const RELEASES_LATEST_API = `https://api.github.com/repos/${ GITHUB_REPO }/releases/latest`

// User-local install dir — chosen so `babysit update` never needs sudo.
// Must stay in sync with scripts/install.sh's INSTALL_DIR.
const USER_INSTALL_DIR = join( homedir(), `.local`, `bin` )
const USER_INSTALL_PATH = join( USER_INSTALL_DIR, `babysit` )

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const BABYSIT_REPO_ROOT = join( __dirname, `..`, `..` )

/**
 * `babysit update` — the only update path. Refreshes:
 *   1. babysit itself (git pull for source checkouts, GitHub release download
 *      for compiled installs — see scripts/install.sh)
 *   2. ~/.agents (git pull, if it's a git repo)
 *   3. the docker image (docker pull)
 *   4. host-installed coding agent CLIs (claude / codex / gemini / opencode)
 *      using each agent's declared strategy chain — see deps/agent_update.js
 *
 * Steps run sequentially (not in parallel) so the output reads top-to-bottom,
 * narrating each one so the user can see what happened, what was skipped, and
 * what failed. Step result icons follow common CLI conventions: ✓ done,
 * → skipped, ✗ failed.
 *
 * Regular subcommands (`babysit start` / `resume` / etc.) no longer auto-update
 * on boot, so this verb is how users opt in.
 *
 * @returns {Promise<void>}
 */
export const cmd_update = async () => {

    console.log( `\nbabysit update — refreshing local install\n` )

    await update_self()
    await update_agents_repo()
    await update_docker_image()
    await update_host_agent_clis()

    console.log( `\nUpdate complete.\n` )

}

/**
 * Step 1 — update babysit itself. Two modes, picked automatically:
 *   - source checkout (.git in repo root)  → `git pull --ff-only`
 *   - compiled binary (bun-compiled)       → download latest GitHub release
 *
 * Both modes report what they did with the same `[1/4] babysit ...` header
 * so the output shape is consistent regardless of how babysit was installed.
 */
const update_self = async () => {

    if( existsSync( join( BABYSIT_REPO_ROOT, `.git` ) ) ) {
        await update_babysit_source()
        return
    }

    if( is_compiled_binary() ) {
        await update_babysit_binary()
        return
    }

    // Neither a checkout nor a recognisable compiled binary — most likely a
    // node-installed copy run via `node src/index.js` from a non-git dir, or
    // an unusual install layout. We can't safely auto-update either, so
    // surface the situation rather than silently skipping.
    console.log( `[1/4] babysit` )
    console.log( `      ${ process.execPath }` )
    console.log( `      → skipped (not a git checkout and not a compiled binary — install method unknown)\n` )

}

const update_babysit_source = async () => {

    console.log( `[1/4] babysit source` )
    console.log( `      ${ BABYSIT_REPO_ROOT }` )

    try {
        await promise_timeout(
            run( `git`, [ `-C`, BABYSIT_REPO_ROOT, `pull`, `--ff-only` ] ),
            STEP_TIMEOUT_MS
        )
        console.log( `      ✓ git pull --ff-only succeeded\n` )
    } catch ( e ) {
        console.log( `      ✗ git pull failed: ${ e.message }\n` )
    }

}

const update_babysit_binary = async () => {

    // Pick the install target. If the running binary lives somewhere
    // user-writable (the common case after install.sh moved to ~/.local/bin),
    // overwrite in place. Otherwise — typically a legacy /usr/local/bin
    // install from before the user-local switch — write the new binary to
    // ~/.local/bin/babysit instead and leave the old one alone. This keeps
    // `babysit update` strictly sudo-free; the user can manually `sudo rm`
    // the legacy copy at their leisure.
    const running = process.execPath
    const in_place = is_writable( running )
    const target = in_place ? running : USER_INSTALL_PATH
    const platform_tag = binary_platform_tag()

    console.log( `[1/4] babysit binary` )
    console.log( `      running: ${ running }` )
    if( !in_place ) console.log( `      target:  ${ target } (running binary lives in a non-user-writable dir)` )
    console.log( `      platform: ${ platform_tag }` )

    if( !platform_tag ) {
        console.log( `      → skipped (no published binary for ${ platform() }/${ arch() })\n` )
        return
    }

    let release
    try {
        release = await promise_timeout( fetch_latest_release(), STEP_TIMEOUT_MS )
    } catch ( e ) {
        console.log( `      ✗ fetching release metadata failed: ${ e.message }\n` )
        return
    }

    const latest_version = ( release.tag_name || `` ).replace( /^v/, `` )
    console.log( `      latest release: v${ latest_version || `?` } (current: v${ pkg.version })` )

    // Skip the download only when we're updating in place AND already on the
    // latest version. When migrating away from a legacy install dir we still
    // want to write the user-local copy even if versions match, so subsequent
    // updates don't re-trigger the migration message.
    if( in_place && latest_version && latest_version === pkg.version ) {
        console.log( `      → skipped (already on latest)\n` )
        return
    }

    const asset = ( release.assets || [] ).find( a => a.name === `babysit-${ platform_tag }` )
    if( !asset ) {
        console.log( `      ✗ no binary named babysit-${ platform_tag } in release v${ latest_version }\n` )
        return
    }

    const tmpfile = join( tmpdir(), `babysit-update-${ Date.now() }` )
    try {
        await download_to_file( asset.browser_download_url, tmpfile )
        chmodSync( tmpfile, 0o755 )
    } catch ( e ) {
        console.log( `      ✗ download failed: ${ e.message }\n` )
        return
    }

    try {
        // mkdirSync is a no-op when the dir already exists, and creates the
        // ~/.local/bin parent for users on a fresh account. recursive: true
        // matches the install.sh `mkdir -p`.
        mkdirSync( dirname( target ), { recursive: true } )
        await run( `mv`, [ tmpfile, target ] )
        console.log( `      ✓ installed v${ latest_version } to ${ target }\n` )
    } catch ( e ) {
        console.log( `      ✗ install failed: ${ e.message }` )
        console.log( `      (downloaded binary left at ${ tmpfile })\n` )
        return
    }

    if( !in_place ) print_migration_notice( running, target )
    if( !is_on_path( USER_INSTALL_DIR ) ) print_path_warning()

}

/**
 * Print the one-time heads-up shown when we couldn't write the running
 * binary's location and instead wrote a fresh copy to ~/.local/bin.
 * Tells the user how to remove the legacy file manually (the only sudo
 * use in the whole flow, and it's optional).
 */
const print_migration_notice = ( old_path, new_path ) => {
    console.log( `      The previous binary at ${ old_path } was NOT modified.` )
    console.log( `      To remove the legacy copy (one-time, requires sudo):` )
    console.log( `` )
    console.log( `          sudo rm ${ old_path }` )
    console.log( `` )
    console.log( `      Make sure ${ dirname( new_path ) } comes before ${ dirname( old_path ) } on PATH,` )
    console.log( `      otherwise the legacy binary will keep shadowing the new one.\n` )
}

const print_path_warning = () => {
    console.log( `      ⚠  ${ USER_INSTALL_DIR } is not on your PATH — the new binary won't be discoverable.` )
    console.log( `      Add this line to your shell rc (~/.bashrc, ~/.zshrc, etc.):` )
    console.log( `` )
    console.log( `          export PATH="$HOME/.local/bin:$PATH"` )
    console.log( `\n` )
}

/**
 * Step 2 — `git pull` the user's `~/.agents` directory if it's a git repo.
 * Used by users who keep their per-agent prompts/skills under version control.
 */
const update_agents_repo = async () => {

    const has_git = existsSync( join( AGENTS_DIR, `.git` ) )

    console.log( `[2/4] ~/.agents (per-agent prompts and skills)` )
    console.log( `      ${ AGENTS_DIR }` )

    if( !has_git ) {
        console.log( `      → skipped (no git repo at ~/.agents)\n` )
        return
    }

    try {
        await promise_timeout(
            run( `git`, [ `-C`, AGENTS_DIR, `pull`, `--ff-only` ] ),
            STEP_TIMEOUT_MS
        )
        console.log( `      ✓ git pull --ff-only succeeded\n` )
    } catch ( e ) {
        console.log( `      ✗ git pull failed: ${ e.message }\n` )
    }

}

/**
 * Step 3 — pull the latest published babysit container image from Docker Hub.
 * This is what changes most often (rebuilt on every release of babysit).
 */
const update_docker_image = async () => {

    const image = get_image_name()

    console.log( `[3/4] docker image` )
    console.log( `      ${ image }` )

    try {
        await promise_timeout(
            run( `docker`, [ `pull`, image ] ),
            DOCKER_PULL_TIMEOUT_MS
        )
        console.log( `      ✓ docker pull succeeded\n` )
    } catch ( e ) {
        console.log( `      ✗ docker pull failed: ${ e.message }\n` )
    }

}

// Per-agent host CLI upgrade is network-bound (npm registry, brew bottle
// download, agent self-update endpoint). Generous ceiling — a stuck `claude
// update` shouldn't gate the next agent.
const AGENT_UPDATE_TIMEOUT_MS = 60_000

/**
 * Step 4 — upgrade each supported coding agent CLI on the host
 * (claude / codex / gemini / opencode). Per-agent narration: skip cleanly
 * when the binary isn't on PATH, otherwise try the registered strategies in
 * order (self_update → npm → brew, gated by realpath detection so an
 * npm-installed agent never accidentally triggers brew). The docker image
 * carries its own pinned copies, so failures here are non-fatal.
 */
const update_host_agent_clis = async () => {

    console.log( `[4/4] host coding agent CLIs` )

    for( const name of SUPPORTED_AGENTS ) {

        const agent = get_agent( name )

        if( !command_exists( agent.bin ) ) {
            console.log( `      ${ name }: → not installed on host, skipping` )
            continue
        }

        const strategies = build_update_strategies( agent )
        if( strategies.length === 0 ) {
            console.log( `      ${ name }: → no update strategies registered, skipping` )
            continue
        }

        let succeeded = false
        let last_error = null

        for( const strategy of strategies ) {

            if( strategy.detect && !strategy.detect() ) continue

            try {
                await promise_timeout(
                    run( strategy.cmd, strategy.args ),
                    AGENT_UPDATE_TIMEOUT_MS
                )
                console.log( `      ${ name }: ✓ updated via ${ strategy.name }` )
                succeeded = true
                break
            } catch ( e ) {
                last_error = e
            }

        }

        if( !succeeded ) {
            const detail = last_error ? `: ${ last_error.message }` : ` (no matching strategy)`
            console.log( `      ${ name }: ✗ all strategies failed${ detail }` )
        }

    }

    console.log( `` )

}

// --- helpers ---------------------------------------------------------------

/**
 * Detect whether the current process is the bun-compiled babysit binary.
 * Same heuristic as src/cli/start.js#spawn_monitor_daemon: bun sets
 * argv[1] to a synthetic `/$bunfs/...` path; node sets it to the .js entry.
 * @returns {boolean}
 */
export const is_compiled_binary = () => {
    const argv1 = process.argv[1] || ``
    return argv1.startsWith( `/$bunfs` ) || argv1 === ``
}

/**
 * Map the running platform/arch onto the release-asset suffix used by
 * scripts/install.sh and the .github/workflows release pipeline. Returns
 * null for unsupported combinations so the caller can skip cleanly.
 * @returns {string|null}
 */
export const binary_platform_tag = () => {

    const os_map = { darwin: `darwin`, linux: `linux` }
    const arch_map = { x64: `x64`, arm64: `arm64` }

    const os = os_map[ platform() ]
    const cpu = arch_map[ arch() ]
    if( !os || !cpu ) return null
    return `${ os }-${ cpu }`

}

/** @returns {Promise<{ tag_name: string, assets: { name: string, browser_download_url: string }[] }>} */
const fetch_latest_release = async () => {

    const response = await fetch( RELEASES_LATEST_API, {
        headers: {
            accept: `application/vnd.github+json`,
            'user-agent': `babysit-updater`,
        },
    } )

    if( !response.ok ) {
        throw new Error( `GitHub API returned ${ response.status } ${ response.statusText }` )
    }

    return await response.json()

}

/**
 * Stream a URL into a file via curl. We shell out instead of piping the
 * fetch body through Node so a network stall hits curl's own connect/read
 * timeouts (and so progress goes through the kernel rather than the JS
 * heap for ~50 MB binaries).
 */
const download_to_file = ( url, dest ) =>
    run( `curl`, [ `-fsSL`, `-o`, dest, url ], {}, BINARY_DOWNLOAD_TIMEOUT_MS )

/**
 * Writability check for the install target — both the file (so we can
 * overwrite it) and its containing directory (so we can `mv` over it,
 * which on POSIX is unlink + create). Defaults to false on error so the
 * migration branch fires — wrong-direction conservatism.
 */
const is_writable = ( path ) => {
    try {
        accessSync( path, fs_constants.W_OK )
        accessSync( dirname( path ), fs_constants.W_OK )
        return true
    } catch {
        return false
    }
}

/**
 * Plain string check — does the given directory appear in $PATH? Used to
 * warn when a fresh `~/.local/bin` install wouldn't be discoverable.
 */
export const is_on_path = ( dir ) => {
    const sep = platform() === `win32` ? `;` : `:`
    return ( process.env.PATH || `` ).split( sep ).includes( dir )
}
