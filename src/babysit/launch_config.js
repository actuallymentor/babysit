import { readFileSync } from 'fs'
import { parse } from 'yaml'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { parse_args } from '../cli/parse.js'

export const LAUNCH_MODES = [ `regular`, `sandbox`, `mudbox` ]
export const LAUNCH_TOGGLES = [ `yolo`, `docker`, `adb`, `clone`, `loop`, `ignore_host_agents_md` ]

// Every key a `launch:` section declares. `name` is the only optional one:
// directory launches derive it from the yaml path.
export const LAUNCH_KEYS = [ `agent`, `name`, `mode`, ...LAUNCH_TOGGLES, `ports`, `log`, `args` ]

/**
 * Fresh launch defaults, matching an unflagged `babysit <agent>`.
 * @param {Object} [overrides] - Values to replace
 * @returns {Object} Complete launch section
 */
export const default_launch = ( overrides = {} ) => ( {
    agent: SUPPORTED_AGENTS[0],
    mode: `regular`,
    ...Object.fromEntries( LAUNCH_TOGGLES.map( key => [ key, false ] ) ),
    ports: [],
    log: false,
    args: [],
    ...overrides,
} )

/**
 * Read the raw `launch:` section of a yaml file.
 * @param {string} path - Yaml file
 * @returns {Object|null} Raw section, or null when the file has none
 * @throws On unreadable files and yaml syntax errors
 */
export const read_launch_section = path => {

    const parsed = parse( readFileSync( path, `utf-8` ) ) || {}
    return parsed.launch ?? null

}

// One check per key: returns an error message, or nothing when the value is valid.
const CHECKS = {
    agent: value => SUPPORTED_AGENTS.includes( value ) ? null : `must be one of ${ SUPPORTED_AGENTS.join( `, ` ) }`,
    name: value => typeof value === `string` && value.trim() ? null : `must be a non-empty string`,
    mode: value => LAUNCH_MODES.includes( value ) ? null : `must be one of ${ LAUNCH_MODES.join( `, ` ) }`,
    ...Object.fromEntries( LAUNCH_TOGGLES.map( key => [ key, value => typeof value === `boolean` ? null : `must be true or false` ] ) ),
    ports: value => Array.isArray( value ) && value.every( port => [ `string`, `number` ].includes( typeof port ) ) ? null : `must be a list of PORT or HOST:CONTAINER entries ([] for none)`,
    log: value => typeof value === `boolean` || typeof value === `string` && value.trim() ? null : `must be false, true (default path), or a file path`,
    args: value => Array.isArray( value ) && value.every( arg => [ `string`, `number` ].includes( typeof arg ) ) ? null : `must be a list of agent CLI arguments ([] for none)`,
}

/**
 * Problem with one `launch:` value, as validate_launch words it after the key.
 * @param {string} key - Launch key
 * @param {*} value - Raw value
 * @returns {string|null} e.g. `must be true or false`; null when valid or the key is unknown
 */
export const launch_key_problem = ( key, value ) => CHECKS[ key ]?.( value ) ?? null

/**
 * Validate a `launch:` section.
 *
 * Strict mode (directory launches) requires every key but `name`, each with a
 * non-null value; lists may be empty. Lenient mode (menu prefill) accepts a
 * partial section and fills the gaps with defaults.
 *
 * @param {Object|null} raw - Raw section
 * @param {Object} [options]
 * @param {boolean} [options.strict=false] - Require every key
 * @returns {{ launch: Object, declared: Object, errors: string[] }} Normalised section, the valid keys it set, and problems found
 */
export const validate_launch = ( raw, { strict = false } = {} ) => {

    if( raw === null || raw === undefined ) {
        return { launch: default_launch(), declared: {}, errors: strict ? [ `missing launch: section` ] : [] }
    }
    if( typeof raw !== `object` || Array.isArray( raw ) ) return { launch: default_launch(), declared: {}, errors: [ `launch: must be a mapping of keys` ] }

    const errors = []

    for( const key of Object.keys( raw ) ) {
        if( !LAUNCH_KEYS.includes( key ) ) errors.push( `launch.${ key } is not a known key` )
    }

    for( const key of LAUNCH_KEYS ) {

        const present = Object.hasOwn( raw, key ) && raw[ key ] !== null
        if( !present ) {
            if( strict && key !== `name` ) errors.push( `launch.${ key } is required` )
            continue
        }

        const problem = CHECKS[ key ]( raw[ key ] )
        if( problem ) errors.push( `launch.${ key } ${ problem }` )

    }

    // Valid keys the file actually sets; the menu prefill takes only these
    const declared = Object.fromEntries( LAUNCH_KEYS
        .filter( key => Object.hasOwn( raw, key ) && raw[ key ] !== null && !CHECKS[ key ]( raw[ key ] ) )
        .map( key => [ key, raw[ key ] ] ) )
    const launch = default_launch( declared )

    if( launch.clone && launch.mode !== `regular` ) errors.push( `launch.clone cannot be combined with mode: ${ launch.mode }` )

    return { launch, declared, errors }

}

/**
 * The Babysit flags a launch section stands for, minus agent and name.
 * @param {Object} launch - Validated launch section
 * @returns {string[]} e.g. `[ '--yolo', '--docker', '--port=3000' ]`
 */
export const launch_flags = launch => [
    ...[ `yolo`, `docker`, `adb`, `clone`, `loop` ].filter( key => launch[ key ] ).map( key => `--${ key }` ),
    ...launch.mode === `regular` ? [] : [ `--${ launch.mode }` ],
    ...launch.ignore_host_agents_md ? [ `--ignore-host-agents-md` ] : [],
    ...launch.ports.map( port => `--port=${ port }` ),
    ...launch.log === false ? [] : [ launch.log === true ? `--log` : `--log=${ launch.log }` ],
]

/**
 * Build the start command a launch section describes.
 * @param {Object} launch - Validated launch section
 * @param {Object} [options]
 * @param {string|null} [options.config_path] - Absolute yaml path the session supervises with
 * @param {string|null} [options.name] - Name used when the section has none
 * @returns {Object} Parsed command, as `babysit <agent> [flags]` would produce
 * @throws When the flags are rejected, e.g. an all-digit name
 */
export const launch_to_command = ( launch, { config_path = null, name = null } = {} ) => {

    const session_name = launch.name || name
    const argv = [
        launch.agent,
        // `--log=` pins the default path; a bare `--log` would read the next word
        ...launch_flags( launch ).map( flag => flag === `--log` ? `--log=` : flag ),
        ...session_name ? [ `--name=${ session_name }` ] : [],
        ...config_path ? [ `--config=${ config_path }` ] : [],
    ]

    // Agent arguments bypass Babysit's parser so they can never be read as Babysit flags
    return { ...parse_args( argv ), passthrough: launch.args.map( String ) }

}

/**
 * Turn a parsed start command back into a launch section (`babysit init`).
 * @param {Object} cmd - Parsed start command
 * @returns {Object} Launch section; `name` only when one was given
 */
export const command_to_launch = ( { agent, flags = {}, passthrough = [] } ) => default_launch( {
    agent,
    mode: flags.sandbox ? `sandbox` : flags.mudbox ? `mudbox` : `regular`,
    ...Object.fromEntries( LAUNCH_TOGGLES.map( key => [ key, Boolean( flags[ key ] ) ] ) ),
    ports: flags.ports || [],
    log: typeof flags.log === `string` ? flags.log || true : false,
    args: passthrough,
    ...flags.name ? { name: flags.name } : {},
} )

/**
 * Render a launch section as commented yaml (`babysit init`).
 * @param {Object} launch - Launch section
 * @returns {string} `launch:` block
 */
export const build_launch_yaml = launch => {

    const list = items => `[${ items.map( item => JSON.stringify( String( item ) ) ).join( `, ` ) }]`
    const log = typeof launch.log === `string` ? JSON.stringify( launch.log ) : launch.log

    return `# How the session starts. \`babysit --config DIR/\` starts one session per yaml in
# DIR and requires every key below except name (lists may be empty); a bare
# \`babysit --config FILE\` opens the launch menu with these values.
launch:
    # ${ SUPPORTED_AGENTS.join( ` | ` ) }
    agent: ${ launch.agent }

    # Directory launches default to the yaml path relative to DIR.
    ${ launch.name ? `name: ${ JSON.stringify( launch.name ) }` : `# name: my session` }

    # regular | sandbox | mudbox; clone needs regular.
    mode: ${ launch.mode }

    yolo: ${ launch.yolo }
    docker: ${ launch.docker }
    adb: ${ launch.adb }
    clone: ${ launch.clone }
    loop: ${ launch.loop }
    ignore_host_agents_md: ${ launch.ignore_host_agents_md }

    # PORT or HOST:CONTAINER entries.
    ports: ${ list( launch.ports ) }

    # false, true for the default path, or a file path.
    log: ${ log }

    # Passed to the agent CLI as-is, e.g. ["--model", "opus"].
    args: ${ list( launch.args ) }
`

}
