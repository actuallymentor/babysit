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
    commands:
        notify_command: >
            curl -f -X POST -d \\
                "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&title=Babysit&message=I need your input&url=&priority=0" https://api.pushover.net/1/messages.json

# Babysit instructions
babysit:

    # Format:
    # - on: <event> # unquoted words are special keywords, quotes words are literal matches, regex is supported with /regex/flags. Note that the \`on:\` only triggers if the match is the latest seen output for longer than the timeout
    #   do: <action> # unquoted words are special keywords or commands specified in config.commands, quoted words are literal input followed by and enter keystroke

    # This instructs babysit to type and submit "check for bugs" into the tmux session when the coding agent is idle for the timeout period (including sub agents)
    - on: idle # this means no new output in the tmux session
      do: ./IDLE.md # this may point to any markdown file on the host, either as a relative or absolute path
      timeout: 30:00 # overrides idle_timeout_s, format can be: SS, MM:SS, or HH:MM:SS

    # This instructs babysit to accept any plan that the coding agent submits by pressing "enter" when it encounters a plan acceptance step
    # - on: plan # this means the coding agent is asking the user to accept a plan
    #   do: enter
    #   timeout: 10 # waits 10 seconds

    # Instructs babysit to run the notify_command when the coding agent is waiting for user input, so that the user gets a push notification on their phone to check the session
    - on: choice # this is a generic option for any scenario the coding agent is waiting for user input
      do: notify_command
      timeout: 1:00:00 # Waits 1 hour

    - on: /error/i # regex match on the tmux session output, case insensitive
      do: notify_command
      timeout: 05:00
`

/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    initial_prompt: null,
    idle_timeout_s: 300,
    commands: {},
    lines_for_literal_match: 10,
    lines_for_regex_match: 10,
    isolate_dependencies: true,
}

/**
 * Load babysit.yaml from the current directory, creating a default if missing
 * @param {string} [dir=process.cwd()] - Directory to look for babysit.yaml
 * @param {Object} [options]
 * @param {string} [options.default_initial_prompt] - Prompt to write into a newly-created babysit.yaml
 * @returns {{ config: Object, rules: Array }} Parsed config and rules
 */
export const load_config = ( dir = process.cwd(), { default_initial_prompt = build_system_prompt( {} ) } = {} ) => {

    const config_path = resolve( dir, `babysit.yaml` )

    // Create default if not present
    if( !existsSync( config_path ) ) {
        log.info( `Creating default babysit.yaml` )
        writeFileSync( config_path, build_default_yaml( { initial_prompt: default_initial_prompt } ), `utf-8` )
    }

    const raw = readFileSync( config_path, `utf-8` )
    const parsed = parse( raw ) || {}

    // Merge with defaults
    const config = { ...DEFAULT_CONFIG, ... parsed.config || {}  }

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

    return {
        on: parse_on( on_value ),
        do: do_value,
        timeout_s: timeout ? parse_timeout( timeout ) : null,

        // Set when the monitor sees a rule's match condition flip from false to true.
        // Cleared whenever the match goes false again, so the per-rule "has been
        // visible for X seconds" check re-arms cleanly across flap cycles.
        first_matched_at: null,

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
    if( str === `plan` ) return { type: `plan` }
    if( str === `choice` ) return { type: `choice` }

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
