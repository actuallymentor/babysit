import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { promise_timeout } from 'mentie'

import { run } from '../utils/exec.js'
import { AGENTS_DIR } from '../utils/paths.js'
import { get_image_name } from '../docker/update.js'

// Same budget per step as the pre-flight self-update — keeps a hung remote
// from holding the user hostage. See src/deps/selfupdate.js.
const STEP_TIMEOUT_MS = 15_000
const DOCKER_PULL_TIMEOUT_MS = 120_000

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const BABYSIT_REPO_ROOT = join( __dirname, `..`, `..` )

/**
 * `babysit update` — runs the same three updates as the silent pre-flight
 * (babysit repo git pull, ~/.agents git pull, docker image pull), but
 * narrates each step so the user can see what's happening, what was skipped,
 * and what failed. Steps run sequentially (not in parallel like the
 * pre-flight) so the output reads top-to-bottom.
 *
 * Step result icons match common CLI conventions: ✓ done, → skipped, ✗ failed.
 *
 * @returns {Promise<void>}
 */
export const cmd_update = async () => {

    console.log( `\nbabysit update — refreshing local install\n` )

    await update_babysit_repo()
    await update_agents_repo()
    await update_docker_image()

    console.log( `\nUpdate complete.\n` )

}

/**
 * Step 1 — `git pull` the babysit checkout itself.
 * Skipped when running from a compiled binary (no .git in repo root).
 */
const update_babysit_repo = async () => {

    const has_git = existsSync( join( BABYSIT_REPO_ROOT, `.git` ) )

    console.log( `[1/3] babysit source` )
    console.log( `      ${ BABYSIT_REPO_ROOT }` )

    if( !has_git ) {
        console.log( `      → skipped (not a git checkout — likely a compiled binary install)\n` )
        return
    }

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

/**
 * Step 2 — `git pull` the user's `~/.agents` directory if it's a git repo.
 * Used by users who keep their per-agent prompts/skills under version control.
 */
const update_agents_repo = async () => {

    const has_git = existsSync( join( AGENTS_DIR, `.git` ) )

    console.log( `[2/3] ~/.agents (per-agent prompts and skills)` )
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

    console.log( `[3/3] docker image` )
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
