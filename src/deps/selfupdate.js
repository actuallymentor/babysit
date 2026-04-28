import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { promise_timeout } from 'mentie'
import { run } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { AGENTS_DIR } from '../utils/paths.js'
import { pull_image } from '../docker/update.js'

// Timeout for each update operation
const UPDATE_TIMEOUT_MS = 15_000

const __dirname = dirname( fileURLToPath( import.meta.url ) )
const BABYSIT_REPO_ROOT = join( __dirname, `..`, `..` )

/**
 * Run pre-flight self-update tasks in parallel:
 * - git pull on the babysit repo (if installed from source / git clone)
 * - git pull on ~/.agents (if it exists)
 * - docker pull latest container image
 * @returns {Promise<void>}
 */
export const run_self_update = async () => {

    const tasks = []

    // Pull the babysit repo if it's a git checkout (skipped for compiled binaries)
    if( existsSync( join( BABYSIT_REPO_ROOT, `.git` ) ) ) {
        tasks.push(
            promise_timeout(
                run( `git`, [ `-C`, BABYSIT_REPO_ROOT, `pull`, `--quiet` ] ),
                UPDATE_TIMEOUT_MS
            ).then( () => log.debug( `babysit repo updated` ) )
                .catch( e => log.debug( `babysit pull failed: ${ e.message }` ) )
        )
    }

    // Pull ~/.agents if it's a git repo
    if( existsSync( `${ AGENTS_DIR }/.git` ) ) {
        tasks.push(
            promise_timeout(
                run( `git`, [ `-C`, AGENTS_DIR, `pull`, `--quiet` ] ),
                UPDATE_TIMEOUT_MS
            ).then( () => log.debug( `~/.agents updated` ) )
                .catch( e => log.debug( `~/.agents pull failed: ${ e.message }` ) )
        )
    }

    // Pull latest docker image
    tasks.push(
        pull_image().catch( e => log.debug( `Docker pull failed: ${ e.message }` ) )
    )

    await Promise.allSettled( tasks )

}
