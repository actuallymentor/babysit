import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { parse } from 'yaml'
import { log } from '../utils/log.js'
import { parse_timeout } from './timeout.js'
import { build_system_prompt } from '../modes/prompt.js'

const yaml_block = ( text ) => String( text ).split( `\n` )
    .map( line => `        ${ line }` )
    .join( `\n` )

const format_initial_prompt = ( text ) => {

    if( !text ) return `""`

    return `|-\n${ yaml_block( text ) }`

}

const build_default_yaml = ( { initial_prompt = build_system_prompt( {} ) } = {} ) => `# babysit.yaml

# Babysit configuration
config:
    # Prompt typed into the agent screen on launch. Set to null or "" to disable.
    initial_prompt: ${ format_initial_prompt( initial_prompt ) }
    idle_timeout_s: 300 # The amount of seconds of inactivity (no output in the tmux session) that count as \`on: idle\`
    yolo_approve_dangerous_commands: true # YOLO only: answer Claude's bypass-immune "Dangerous rm operation" prompt with Yes; false lets Claude auto-deny it

    # --clone workspace creation. Defaults shown; uncomment to change.
    # clone:
    #     mode: git                   # git: clone the repository's committed state (fast); copy: copy the working tree
    #     carry: ['.env', '.env.*', '.notes', 'babysit.yaml'] # git mode: untracked/ignored paths copied in (gitignore-style patterns)
    #     changes: false              # git mode: also carry uncommitted edits and untracked files
    #     depth: null                 # git mode: shallow history depth; null keeps full history
    #     exclude: ['node_modules']   # directory or file names skipped everywhere

    # Named shell commands are opt-in. Uncomment and configure before use.
    # commands:
    #     notify_command: >
    #         curl -f -X POST -d \\
    #             "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input&url=&priority=0" https://api.pushover.net/1/messages.json

# Babysit instructions
babysit:

    # Format:
    # - on: <event> # idle, a literal string found in the last 10 lines of output, or /regex/flags
    #   do: <action> # enter, a command named in config.commands, a Markdown file (=== separates steps), or text to type

    # Examples are disabled until you uncomment and configure them.

    # Send a markdown workflow when the coding agent is idle.
    # - on: idle # this means no new output in the tmux session
    #   do: ./IDLE.md # create this file first; relative and absolute paths work
    #   timeout: 30:00 # overrides idle_timeout_s; SS, MM:SS, or HH:MM:SS

    # Run the configured notification command when the agent reports an error.
    # - on: /error/i
    #   do: notify_command
`

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    initial_prompt: null,
    idle_timeout_s: 300,
    yolo_approve_dangerous_commands: true,
    commands: {},
    isolate_dependencies: true,
}

/**
 * Clone creation defaults. Secrets and notes are the usual untracked files a
 * clone still needs; dependencies are never worth copying.
 */
export const DEFAULT_CLONE_CONFIG = {
    mode: `git`,
    carry: [ `.env`, `.env.*`, `.notes`, `babysit.yaml` ],
    changes: false,
    depth: null,
    exclude: [ `node_modules` ],
}

const string_list = ( value, fallback ) => Array.isArray( value )
    ? value.filter( item => typeof item === `string` && item.trim() ).map( item => item.trim() )
    : fallback

/**
 * Read `config.clone` from a workspace's babysit.yaml without creating the file.
 * Clone creation runs before the workspace config is loaded and must read the
 * source, which may have no babysit.yaml yet.
 * @param {string} [dir=process.cwd()] - Source workspace
 * @returns {{ mode: string, carry: string[], changes: boolean, depth: number|null, exclude: string[] }}
 */
export const load_clone_config = ( dir = process.cwd() ) => {

    const config_path = resolve( dir, `babysit.yaml` )
    let raw = {}

    try {
        raw = parse( readFileSync( config_path, `utf-8` ) )?.config?.clone || {}
    } catch {
        // Missing or unreadable yaml means defaults; load_config reports syntax later.
    }

    if( raw.mode !== undefined && ![ `git`, `copy` ].includes( raw.mode ) ) log.warn( `config.clone.mode "${ raw.mode }" is not git or copy; using git` )
    if( raw.depth !== undefined && raw.depth !== null && !( Number.isInteger( raw.depth ) && raw.depth > 0 ) ) log.warn( `config.clone.depth must be a positive integer; keeping full history` )
    const depth = Number.isInteger( raw.depth ) && raw.depth > 0 ? raw.depth : null

    // Excludes feed rsync and the matcher alike, so only plain names are allowed.
    const exclude = string_list( raw.exclude, DEFAULT_CLONE_CONFIG.exclude ).filter( name => {
        const plain = !/[/*?[\]\\]/.test( name )
        if( !plain ) log.warn( `config.clone.exclude entry "${ name }" ignored: use plain directory or file names` )
        return plain
    } )

    return {
        mode: raw.mode === `copy` ? `copy` : `git`,
        carry: string_list( raw.carry, DEFAULT_CLONE_CONFIG.carry ),
        changes: raw.changes === true,
        depth,
        exclude,
    }

}

/**
 * Write the commented default babysit.yaml into a workspace (`babysit init`).
 * @param {string} [dir=process.cwd()] - Workspace
 * @param {Object} [options]
 * @param {string} [options.initial_prompt] - Prompt to embed
 * @returns {string} Path written
 */
export const write_default_config = ( dir = process.cwd(), { initial_prompt = build_system_prompt( {} ) } = {} ) => {

    const config_path = resolve( dir, `babysit.yaml` )
    if( existsSync( config_path ) ) throw new Error( `${ config_path } already exists; edit it or remove it first` )
    writeFileSync( config_path, build_default_yaml( { initial_prompt } ), `utf-8` )
    return config_path

}

/**
 * Load babysit.yaml from the current directory. A missing file means the
 * defaults; nothing is written (`babysit init` creates the file on request).
 * @param {string} [dir=process.cwd()] - Directory to look for babysit.yaml
 * @param {Object} [options]
 * @param {string} [options.default_initial_prompt] - Prompt used when the file omits initial_prompt
 * @returns {{ config: Object, rules: Array }} Parsed config and rules
 */
export const load_config = ( dir = process.cwd(), { default_initial_prompt = build_system_prompt( {} ) } = {} ) => {

    const config_path = resolve( dir, `babysit.yaml` )
    const parsed = ( existsSync( config_path ) ? parse( readFileSync( config_path, `utf-8` ) ) : null ) || {}

    // Merge with defaults. Older babysit.yaml files may predate
    // config.initial_prompt; treat absence as "use the generated default",
    // while preserving explicit null / "" as opt-outs.
    const raw_config = parsed.config || {}
    const config = { ...DEFAULT_CONFIG, ...raw_config }
    if( !Object.hasOwn( raw_config, `initial_prompt` ) ) {
        config.initial_prompt = default_initial_prompt
    }

    // Parse the rules array
    const raw_rules = Array.isArray( parsed.babysit ) ? parsed.babysit : []
    const rules = raw_rules.map( parse_rule )

    return { config, rules }

}

/**
 * Parse a single babysit rule from the yaml
 * @param {Object} raw_rule - Raw { on, do, timeout } from yaml
 * @returns {Object} Parsed rule with type, matcher, action, timeout_s
 */
const parse_rule = ( raw_rule ) => {

    const { on: on_value, do: do_value, timeout } = raw_rule
    const on = parse_on( on_value )

    // Only idle has a duration to override; other rules fire as soon as they match.
    if( timeout && on.type !== `idle` ) log.warn( `babysit.yaml: timeout on an "${ on_value }" rule is ignored; only idle rules take one` )

    return {
        on,
        do: do_value,
        timeout_s: timeout && on.type === `idle` ? parse_timeout( timeout ) : null,

        // Last-fire timestamp for the per-rule debounce that suppresses
        // double-fires from TUI redraw flicker.
        last_fired_at: 0,
    }

}

/**
 * Parse the `on:` field into a structured matcher descriptor
 * @param {string} value - The on: value from yaml
 * @returns {{ type: string, value: any }}
 */
const parse_on = ( value ) => {

    const str = String( value ).trim()

    // Keywords
    if( str === `idle` ) return { type: `idle` }

    // Regex: /pattern/flags
    const regex_match = str.match( /^\/(.+)\/([gimsuy]*)$/ )
    if( regex_match ) {
        return { type: `regex`, value: new RegExp( regex_match[1], regex_match[2] ) }
    }

    // Literal string (quoted or unquoted)
    return { type: `literal`, value: str.replace( /^["']|["']$/g, `` ) }

}

/**
 * Get the raw default yaml template string
 * @param {Object} [options]
 * @param {string} [options.initial_prompt] - Prompt to include in the default yaml
 * @returns {string} The default babysit.yaml content
 */
export const get_default_yaml = ( options = {} ) => build_default_yaml( options )
