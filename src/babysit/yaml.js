import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, relative, resolve } from 'path'
import { parse } from 'yaml'
import { log } from '../utils/log.js'
import { parse_timeout } from './timeout.js'
import { build_system_prompt } from '../modes/prompt.js'

// Every line of the generated file is a comment: defaults apply until a line
// is uncommented, and the file documents what can be changed.
const comment_block = ( text, indent = `        ` ) => String( text ).split( `\n` )
    .map( line => `#${ indent }${ line }` )
    .join( `\n` )

const build_default_yaml = ( { initial_prompt = build_system_prompt( {} ) } = {} ) => `# babysit.yaml
#
# Babysit configuration. Everything here is commented out; the values shown are
# the defaults. Uncomment a line to change it. Delete this file to go back to
# the defaults entirely.

# config:
#     # Prompt typed into the agent once it is ready. null or "" sends nothing.
#     initial_prompt: |-
${ comment_block( initial_prompt ) }
#
#     # Seconds without new output before the agent counts as idle (on: idle, --loop).
#     idle_timeout_s: 300
#
#     # YOLO only: answer Claude's bypass-immune "Dangerous rm operation" prompt with Yes.
#     # false lets Claude auto-deny it.
#     yolo_approve_dangerous_commands: true
#
#     # Mount Docker volumes over dependency folders (node_modules and friends) so the
#     # container's Linux binaries never land in the host checkout.
#     isolate_dependencies: true
#
#     # --clone workspace creation.
#     clone:
#         mode: git                   # git: clone the committed state (fast); copy: copy the working tree
#         carry: ['.env', '.env.*', '.notes', 'babysit.yaml'] # git mode: untracked or ignored paths copied in (gitignore-style)
#         changes: false              # git mode: also carry uncommitted edits and untracked files
#         depth: null                 # git mode: shallow history depth; null keeps full history
#         exclude: ['node_modules']   # directory or file names skipped everywhere
#
#     # Shell commands a rule can run by name.
#     commands:
#         notify_command: >
#             curl -f -X POST -d \\
#                 "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input&url=&priority=0" https://api.pushover.net/1/messages.json

# Supervision rules, checked top-down every second; the first match acts.
#
#   on:  idle                 no new output for idle_timeout_s (or this rule's timeout)
#        "literal text"       text seen in the last 10 lines of the pane
#        /regex/flags         regex matched against the last 10 lines
#   do:  enter                press Enter
#        notify_command       run a command named under config.commands
#        ./FILE.md            type the file's contents; === on its own line splits it
#                             into steps, and Babysit waits for idle between steps
#        any other text       type it, followed by Enter
#   timeout: SS | MM:SS | HH:MM:SS   idle rules only; overrides idle_timeout_s
#
# --loop replaces the idle rule's action with ./LOOP.md, ~/.agents/LOOP.md, or "Keep going".

# babysit:
#     - on: idle
#       do: ./IDLE.md
#       timeout: 30:00
#
#     - on: /error/i
#       do: notify_command
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
 * Read `config.clone` from a workspace's config without creating the file.
 * Clone creation runs before the workspace config is loaded and must read the
 * source, which may have no babysit.yaml yet.
 * @param {string} [dir=process.cwd()] - Source workspace
 * @param {Object} [options]
 * @param {string|null} [options.config_path] - Explicit --config file
 * @returns {{ mode: string, carry: string[], changes: boolean, depth: number|null, exclude: string[] }}
 */
export const load_clone_config = ( dir = process.cwd(), { config_path = null } = {} ) => {

    const path = config_path || resolve( dir, `babysit.yaml` )
    let raw = {}

    try {
        raw = parse( readFileSync( path, `utf-8` ) )?.config?.clone || {}
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
 * @param {string} [options.file] - File name or path, relative to dir
 * @returns {string} Path written
 */
export const write_default_config = ( dir = process.cwd(), { initial_prompt = build_system_prompt( {} ), file = `babysit.yaml` } = {} ) => {

    const config_path = resolve( dir, file )
    if( existsSync( config_path ) ) throw new Error( `${ config_path } already exists; edit it or remove it first` )
    writeFileSync( config_path, build_default_yaml( { initial_prompt } ), `utf-8` )
    return config_path

}

/**
 * Load the workspace config. A missing babysit.yaml means the defaults and
 * nothing is written (`babysit init` creates it); an explicit --config file
 * must exist.
 * @param {string} [dir=process.cwd()] - Directory to look for babysit.yaml
 * @param {Object} [options]
 * @param {string} [options.default_initial_prompt] - Prompt used when the file omits initial_prompt
 * @param {string|null} [options.config_path] - Explicit --config file
 * @param {string|null} [options.source_dir] - Clone source; a config inside it anchors its markdown to `dir` instead
 * @returns {{ config: Object, rules: Array }} Parsed config and rules
 */
export const load_config = ( dir = process.cwd(), {
    default_initial_prompt = build_system_prompt( {} ),
    config_path = null,
    source_dir = null,
} = {} ) => {

    if( config_path && !existsSync( config_path ) ) throw new Error( `Config file not found: ${ config_path }` )
    const path = config_path || resolve( dir, `babysit.yaml` )
    const parsed = ( existsSync( path ) ? parse( readFileSync( path, `utf-8` ) ) : null ) || {}

    // Merge with defaults. Older babysit.yaml files may predate
    // config.initial_prompt; treat absence as "use the generated default",
    // while preserving explicit null / "" as opt-outs.
    const raw_config = parsed.config || {}
    const config = { ...DEFAULT_CONFIG, ...raw_config }
    if( !Object.hasOwn( raw_config, `initial_prompt` ) ) {
        config.initial_prompt = default_initial_prompt
    }

    // Markdown actions live next to the file that names them, so `./FILE.md`
    // in a --config file outside the workspace still resolves. A clone keeps
    // reading the source's config file but must run the clone's own markdown.
    const config_dir = rebase_dir( dirname( path ), source_dir, dir )
    const raw_rules = Array.isArray( parsed.babysit ) ? parsed.babysit : []
    const rules = raw_rules.map( raw_rule => parse_rule( raw_rule, config_dir, config.commands ) )

    return { config, rules }

}

/**
 * Map a directory inside `from` to the same relative spot inside `to`.
 * Directories outside `from` (or without a `from`) are returned unchanged.
 * @param {string} dir - Directory to map
 * @param {string|null} from - Source root
 * @param {string} to - Target root
 * @returns {string}
 */
const rebase_dir = ( dir, from, to ) => {

    if( !from ) return dir

    // Compare canonical paths: the launcher canonicalizes the source workspace,
    // while --config may have been typed through a symlinked alias.
    const inside = relative( real_path( from ), real_path( dir ) )
    if( inside === `..` || inside.startsWith( `../` ) || isAbsolute( inside ) ) return dir
    return resolve( to, inside )

}

const real_path = path => {
    try {
        return realpathSync( path )
    } catch {
        return path
    }
}

/**
 * Anchor a relative markdown action to the config file's directory. Falls back
 * to the raw value (resolved against cwd at execution time) when no such file
 * exists beside the config, so workspace-relative paths keep working. Named
 * commands are dispatched first by execute_action, so they are never touched.
 * @param {*} value - Raw do: value
 * @param {string} config_dir - Directory holding the yaml file
 * @param {Object} [commands={}] - config.commands lookup
 * @returns {*} Absolute markdown path, or the untouched value
 */
const resolve_markdown_action = ( value, config_dir, commands = {} ) => {

    if( typeof value !== `string` ) return value
    const action = value.trim()
    if( commands?.[ action ] || !action.endsWith( `.md` ) || isAbsolute( action ) ) return value

    const beside_config = resolve( config_dir, action )
    return existsSync( beside_config ) ? beside_config : value

}

/**
 * Parse a single babysit rule from the yaml
 * @param {Object} raw_rule - Raw { on, do, timeout } from yaml
 * @param {string} [config_dir=process.cwd()] - Directory of the yaml file; relative `.md` actions resolve here
 * @param {Object} [commands={}] - config.commands, which take precedence over file paths
 * @returns {Object} Parsed rule with type, matcher, action, timeout_s
 */
const parse_rule = ( raw_rule, config_dir = process.cwd(), commands = {} ) => {

    const { on: on_value, do: raw_do, timeout } = raw_rule
    const on = parse_on( on_value )
    const do_value = resolve_markdown_action( raw_do, config_dir, commands )

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
