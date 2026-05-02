import { existsSync, realpathSync } from 'fs'
import { promise_timeout } from 'mentie'
import { command_exists, run, run_sync } from '../utils/exec.js'
import { log } from '../utils/log.js'
import { SUPPORTED_AGENTS, get_agent } from '../agents/index.js'

// Per-agent update strategies are network-bound (npm registry / brew bottle
// download / agent's own update endpoint) so we give them a generous ceiling.
// Pre-flight runs all four agents in parallel, so worst case we wait this long
// for the slowest one — a stuck `claude update` shouldn't gate the rest.
const UPDATE_TIMEOUT_MS = 60_000

/**
 * Update every supported coding-agent CLI that's currently installed on the
 * host. Failures are logged at debug level — an agent we can't update isn't a
 * blocker for starting a babysit session, since the docker image carries its
 * own pinned copies of each CLI. Runs in parallel across agents.
 * @returns {Promise<void>}
 */
export const update_host_agents = async () => {

    const tasks = SUPPORTED_AGENTS.map( name => {
        const agent = get_agent( name )
        return promise_timeout( update_agent( agent ), UPDATE_TIMEOUT_MS )
            .catch( e => log.debug( `${ name } update failed: ${ e.message }` ) )
    } )

    await Promise.allSettled( tasks )

}

/**
 * Update a single agent. Skips silently when the binary isn't on PATH. Tries
 * each registered strategy in order and returns on the first success. The
 * detect callback gates package-manager strategies to the install method that
 * actually owns the binary — running `npm install -g` against a brew-installed
 * CLI would be a no-op at best and could fork a second copy at worst.
 * @param {Object} agent - Agent adapter (must have .bin, .name, .update)
 * @returns {Promise<void>}
 */
export const update_agent = async ( agent ) => {

    if( !command_exists( agent.bin ) ) {
        log.debug( `${ agent.name } not installed on host — skipping update` )
        return
    }

    const strategies = build_update_strategies( agent )
    if( strategies.length === 0 ) {
        log.debug( `${ agent.name }: no update strategies registered` )
        return
    }

    for( const strategy of strategies ) {

        if( strategy.detect && !strategy.detect() ) {
            log.debug( `${ agent.name }: skipping ${ strategy.name } — detection said no` )
            continue
        }

        try {
            log.debug( `${ agent.name }: trying ${ strategy.name } (${ strategy.cmd } ${ strategy.args.join( ` ` ) })` )
            await run( strategy.cmd, strategy.args, {}, UPDATE_TIMEOUT_MS )
            log.info( `${ agent.name } updated via ${ strategy.name }` )
            return
        } catch ( e ) {
            log.debug( `${ agent.name } ${ strategy.name } failed: ${ e.message }` )
        }

    }

    log.debug( `${ agent.name }: all update strategies failed or skipped` )

}

/**
 * Build the ordered list of update strategies for an agent from its adapter
 * declaration. Order is intentional:
 *   1. self-update — the agent knows best how to update itself
 *   2. npm — only if the binary resolves to a node_modules path
 *   3. brew — only if the binary resolves to a brew prefix
 * The detect functions on the package-manager strategies use the binary's real
 * path, so a brew-installed agent with npm available won't accidentally trigger
 * the npm path.
 * @param {Object} agent
 * @returns {Array<{name:string, cmd:string, args:string[], detect?:Function}>}
 */
export const build_update_strategies = ( agent ) => {

    const strategies = []
    const update = agent.update || {}

    if( update.self_update ) {
        strategies.push( {
            name: `self-update`,
            cmd: update.self_update.cmd,
            args: update.self_update.args,
        } )
    }

    if( update.npm_package ) {
        strategies.push( {
            name: `npm`,
            cmd: `npm`,
            args: [ `install`, `-g`, `${ update.npm_package }@latest` ],
            detect: () => command_exists( `npm` ) && detect_install_method( agent.bin ) === `npm`,
        } )
    }

    if( update.brew_package ) {
        // Casks ship as macOS .app bundles and need the `--cask` switch — bare
        // `brew upgrade <cask>` errors out as "no such formula". The
        // `brew_cask: true` flag in the adapter selects the right syntax.
        const brew_args = update.brew_cask
            ? [ `upgrade`, `--cask`, update.brew_package ]
            : [ `upgrade`, update.brew_package ]

        strategies.push( {
            name: `brew`,
            cmd: `brew`,
            args: brew_args,
            detect: () => command_exists( `brew` ) && detect_install_method( agent.bin ) === `brew`,
        } )
    }

    return strategies

}

/**
 * Resolve a binary on PATH back to its real install method by inspecting the
 * realpath. Symlinks point us at the actual install: npm globals live under a
 * `node_modules/` segment, brew installs under a `Cellar/`, `homebrew/`, or
 * `linuxbrew/` segment. Returns null when neither pattern matches (e.g. a hand-
 * compiled binary in /usr/local/bin) — that just means none of our package-
 * manager strategies apply, and we fall through.
 * @param {string} bin - Binary name (e.g. "claude")
 * @returns {`npm`|`brew`|null}
 */
export const detect_install_method = ( bin ) => {

    const which_output = run_sync( `command -v ${ bin }` )
    if( !which_output ) return null

    let real_path = which_output
    try {
        if( existsSync( which_output ) ) real_path = realpathSync( which_output )
    } catch {
        // realpath failures fall through with the unresolved path — better
        // than returning null and skipping a possibly-correct strategy.
    }

    if( /\/node_modules\//.test( real_path ) ) return `npm`
    if( /\/(Cellar|homebrew|linuxbrew)\//.test( real_path ) ) return `brew`

    return null

}
