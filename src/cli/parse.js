import mri from 'mri'
import { is_agent } from '../agents/index.js'

// Flags babysit recognises — everything else passes through to the agent CLI
const KNOWN_FLAGS = [ `help`, `version`, `yolo`, `sandbox`, `mudbox`, `loop`, `log` ]

// Flags that take an explicit value (e.g. `--log path.log`). collect_passthrough
// uses this to skip the value token too — without that, the user's `--log foo`
// would leak `foo` to the agent CLI.
const VALUE_FLAGS = new Set( [ `log` ] )

/**
 * Parse CLI arguments into a structured command descriptor
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} Parsed command { verb, agent, flags, passthrough }
 */
export const parse_args = ( argv ) => {

    // Pre-process so a bare `--log` (no value) becomes `--log=` and mri's
    // `string` consumer doesn't grab the next flag as the value.
    const prepared = normalise_value_flags( argv )

    // Note: mri's `unknown` callback halts parsing and returns the callback's value
    // — so we omit it. Unknown flags are handled via collect_passthrough below.
    const args = mri( prepared, {
        boolean: [ `help`, `version`, `yolo`, `sandbox`, `mudbox`, `loop` ],
        string: [ `log` ],
        alias: { h: `help`, v: `version` },
    } )

    const positionals = args._
    const verb = positionals[0] || null
    const flags = {
        help: args.help || false,
        version: args.version || false,
        yolo: args.yolo || false,
        sandbox: args.sandbox || false,
        mudbox: args.mudbox || false,
        loop: args.loop || false,
        // Three forms accepted: `--log` (default path), `--log=path`, `--log path`.
        // mri normalises the first two to args.log = '' / args.log = 'path'.
        // false (flag absent) vs string (flag present, possibly empty for default).
        log:  typeof args.log === `string`  ? args.log : false,
    }

    // Sandbox and mudbox describe contradictory mount strategies — fail fast
    // rather than silently picking one in docker/run.js.
    if( flags.sandbox && flags.mudbox ) {
        throw new Error( `--sandbox and --mudbox are mutually exclusive` )
    }

    // Determine what the user wants to do
    // babysit list
    if( verb === `list` ) return { verb: `list`, agent: null, flags, passthrough: [] }

    // babysit update — the only update path: deps check + git pulls + docker
    // pull + host agent CLI updates. Regular subcommands no longer auto-update.
    if( verb === `update` ) return { verb: `update`, agent: null, flags, passthrough: [] }

    // babysit __monitor <id> — internal verb spawned by cmd_start so the
    // monitor outlives the foreground process. Not surfaced in --help.
    if( verb === `__monitor` ) {
        return { verb: `__monitor`, agent: null, session_id: positionals[1], flags, passthrough: [] }
    }

    // babysit open <id>
    if( verb === `open` ) return { verb: `open`, agent: null, session_id: positionals[1], flags, passthrough: [] }

    // babysit resume <id> [--yolo] [extra flags…]
    if( verb === `resume` ) {
        const session_id = positionals[1]
        return {
            verb: `resume`,
            agent: null,
            session_id,
            flags,
            passthrough: collect_passthrough( prepared, null, session_id ),
        }
    }

    // babysit <agent> [resume <id>] [--flags]
    if( verb && is_agent( verb ) ) {

        const agent = verb
        let sub_verb = `start`
        let session_id = null

        // babysit claude resume <id>
        if( positionals[1] === `resume` ) {
            sub_verb = `resume`
            session_id = positionals[2]
        }

        // Collect passthrough args (unknown flags for the agent CLI).
        // Drop the session id when present so the agent adapter is the only place
        // that injects the resume flag — otherwise the id appears twice.
        const passthrough = collect_passthrough( prepared, agent, session_id )

        return { verb: sub_verb, agent, session_id, flags, passthrough }

    }

    // Default: show help
    return { verb: `help`, agent: null, flags, passthrough: [] }

}

/**
 * Collect arguments that are not babysit flags — these pass through to the agent CLI
 * @param {string[]} argv - Raw argv
 * @param {string} agent_name - The agent name (to skip)
 * @param {string|null} [session_id] - Resume session id to drop from passthrough
 * @returns {string[]}
 */
const collect_passthrough = ( argv, agent_name, session_id = null ) => {

    const passthrough = []
    let skip_next = false

    for( const arg of argv ) {

        if( skip_next ) {
            skip_next = false
            continue
        }

        // Skip the agent name (when there is one)
        if( agent_name && arg === agent_name ) continue

        // Skip known verbs
        if( arg === `resume` ) continue

        // Skip the resume session id (the agent adapter injects it via flags.resume)
        if( session_id && arg === session_id ) continue

        // Skip known babysit flags. For value-taking flags written without `=`,
        // we also need to drop the following token — otherwise `--log foo.log`
        // leaks `foo.log` into the agent's argv.
        const [ clean ] = arg.replace( /^-+/, `` ).split( `=` )
        if( KNOWN_FLAGS.includes( clean ) ) {
            if( VALUE_FLAGS.has( clean ) && !arg.includes( `=` ) ) skip_next = true
            continue
        }

        // Skip -h and -v aliases
        if( arg === `-h` || arg === `-v` ) continue

        // Everything else is passthrough
        passthrough.push( arg )
    }

    return passthrough

}

/**
 * Rewrite `--log` (no value, no `=`) as `--log=` before mri parses argv.
 * Without this, mri's `string` mode would consume the *next* token as the
 * value — even when that token is itself a flag like `--yolo`. After the
 * rewrite mri sees an empty string and we treat that as "use the default
 * log path".
 *
 * Idempotent on `--log=...` and `--log <value>` forms — only the standalone
 * `--log` shape is affected.
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
const normalise_value_flags = ( argv ) => {

    const out = []

    for( let i = 0; i < argv.length; i++ ) {

        const arg = argv[i]

        if( arg === `--log` ) {

            const next = argv[i + 1]
            const has_value = next !== undefined && !next.startsWith( `-` )
            out.push( has_value ? arg : `--log=` )
            continue

        }

        out.push( arg )

    }

    return out

}
