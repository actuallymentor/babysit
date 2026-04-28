import mri from 'mri'
import { is_agent } from '../agents/index.js'

// Flags babysit recognises — everything else passes through to the agent CLI
const KNOWN_FLAGS = [ `help`, `version`, `yolo`, `sandbox`, `mudbox`, `loop`, `no-update` ]

/**
 * Parse CLI arguments into a structured command descriptor
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Object} Parsed command { verb, agent, flags, passthrough }
 */
export const parse_args = ( argv ) => {

    const args = mri( argv, {
        boolean: [ `help`, `version`, `yolo`, `sandbox`, `mudbox`, `loop`, `no-update` ],
        alias: { h: `help`, v: `version` },
        unknown: () => true,
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
        no_update: args[`no-update`] || false,
    }

    // Determine what the user wants to do
    // babysit list
    if( verb === `list` ) return { verb: `list`, agent: null, flags, passthrough: [] }

    // babysit open <id>
    if( verb === `open` ) return { verb: `open`, agent: null, session_id: positionals[1], flags, passthrough: [] }

    // babysit resume <id> [--yolo]
    if( verb === `resume` ) return { verb: `resume`, agent: null, session_id: positionals[1], flags, passthrough: [] }

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

        // Collect passthrough args (unknown flags for the agent CLI)
        const passthrough = collect_passthrough( argv, agent )

        return { verb: sub_verb, agent, session_id, flags, passthrough }

    }

    // Default: show help
    return { verb: `help`, agent: null, flags, passthrough: [] }

}

/**
 * Collect arguments that are not babysit flags — these pass through to the agent CLI
 * @param {string[]} argv - Raw argv
 * @param {string} agent_name - The agent name (to skip)
 * @returns {string[]}
 */
const collect_passthrough = ( argv, agent_name ) => {

    const passthrough = []
    let skip_next = false

    for( const arg of argv ) {
        if( skip_next ) {
            skip_next = false; continue 
        }

        // Skip the agent name
        if( arg === agent_name ) continue

        // Skip known verbs
        if( arg === `resume` ) continue

        // Skip known babysit flags
        const clean = arg.replace( /^-+/, `` )
        if( KNOWN_FLAGS.includes( clean ) ) continue

        // Skip -h and -v aliases
        if( arg === `-h` || arg === `-v` ) continue

        // Everything else is passthrough
        passthrough.push( arg )
    }

    return passthrough

}
