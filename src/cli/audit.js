import { existsSync, readFileSync, statSync, writeFileSync } from 'fs'
import { createInterface } from 'readline/promises'
import { dirname, relative } from 'path'
import { isAlias, isMap, isScalar, parseDocument, Scalar } from 'yaml'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { LAUNCH_KEYS, default_launch, launch_key_problem, validate_launch } from '../babysit/launch_config.js'
import { DEFAULT_CLONE_CONFIG, DEFAULT_CONFIG } from '../babysit/yaml.js'
import { build_system_prompt } from '../modes/prompt.js'
import { paint } from '../utils/color.js'
import { launch_dir_files, launch_name_for } from './compose.js'

// `config:` keys audit offers to spell out, in the order `babysit init` documents them
const TUNING_KEYS = [ `initial_prompt`, `idle_timeout_s`, `watchdog_idle_s`, `watchdog_waiting_s`, `yolo_approve_dangerous_commands`, `isolate_dependencies` ]

// One-line explanations written above inserted keys, condensed from `babysit init`
const KEY_COMMENTS = {
    initial_prompt: ` Prompt typed into the agent once it is ready. null or "" sends nothing.`,
    idle_timeout_s: ` Seconds without new output before the agent counts as idle (on: idle, --loop).`,
    watchdog_idle_s: ` Seconds idle, or waiting on background work, before a cheap LLM judges\n whether the agent stalled and nudges it. 0 disables.`,
    yolo_approve_dangerous_commands: ` YOLO only: answer Claude's bypass-immune rm prompts with Yes; false leaves them to a person.`,
    isolate_dependencies: ` Mount Docker volumes over dependency folders so container binaries never reach the host.`,
    clone: ` --clone workspace creation: git clones the committed state, copy copies the working tree.`,
    commands: ` Shell commands a rule can run by name, e.g.\n notify_command: curl -f -X POST -d "token=$PUSHOVER_TOKEN&user=$PUSHOVER_USER&message=I need your input" https://api.pushover.net/1/messages.json`,
    babysit: [
        ` Supervision rules, checked top-down every second; the first match acts.`,
        `   on: idle | "literal text" | /regex/flags (last 10 pane lines)`,
        `   do: enter | a config.commands name | ./FILE.md | any other text`,
        `   timeout: SS | MM:SS | HH:MM:SS (idle rules only)`,
        ` e.g.`,
        `   - on: idle`,
        `     do: ./IDLE.md`,
        `     timeout: 30:00`,
    ].join( `\n` ),
}

const show = value => JSON.stringify( value )

/**
 * Yaml files `babysit audit --config` checks: the directory-launch set for a
 * directory, else the one file.
 * @param {string} config - Absolute FILE or DIR
 * @returns {{ base: string, files: string[] }} Directory names are relative to, and absolute paths
 */
export const audit_targets = config => {

    if( !existsSync( config ) ) throw new Error( `No such file or directory: ${ config }` )
    const directory = statSync( config ).isDirectory()
    return directory
        ? { base: config, files: launch_dir_files( config ) }
        : { base: dirname( config ), files: [ config ] }

}

/**
 * Everything that stops a yaml from starting with `babysit --config DIR/`.
 * @param {string} text - Yaml source
 * @returns {string[]} Syntax errors, or strict launch problems
 */
export const strict_errors = text => {

    const doc = parseDocument( text )
    if( doc.errors.length ) return doc.errors.map( error => error.message.split( `\n` )[0] )

    const parsed = doc.toJS()
    if( parsed !== null && ( typeof parsed !== `object` || Array.isArray( parsed ) ) ) return [ `the file must be a mapping of keys` ]
    return validate_launch( parsed?.launch ?? null, { strict: true } ).errors

}

/**
 * Indent width a yaml already uses, so a rewrite does not reflow the file.
 * @param {string} text - Yaml source
 * @returns {number} Spaces per level; 4 (the `babysit init` style) when unknown
 */
export const yaml_indent = text => text.match( /^( +)[^\s#]/m )?.[1].length || 4

/**
 * Line diff with a little context, `+` green and `-` red.
 * @param {string} before - Original text
 * @param {string} after - Rewritten text
 * @param {Object} [options]
 * @param {number} [options.context=2] - Unchanged lines kept around each change
 * @returns {string[]} Lines; `…` marks skipped unchanged stretches
 */
export const line_diff = ( before, after, { context = 2 } = {} ) => {

    const old_lines = before.split( `\n` )
    const new_lines = after.split( `\n` )

    // Longest-common-subsequence table, filled from the end; configs are small
    const common = Array.from( { length: old_lines.length + 1 }, () => new Array( new_lines.length + 1 ).fill( 0 ) )
    for( let i = old_lines.length - 1; i >= 0; i-- ) {
        for( let j = new_lines.length - 1; j >= 0; j-- ) {
            common[i][j] = old_lines[i] === new_lines[j] ? common[i + 1][j + 1] + 1 : Math.max( common[i + 1][j], common[i][j + 1] )
        }
    }

    // Walk the table into keep/remove/add operations
    const operations = []
    let i = 0
    let j = 0
    while( i < old_lines.length || j < new_lines.length ) {
        if( i < old_lines.length && j < new_lines.length && old_lines[i] === new_lines[j] ) {
            operations.push( { mark: ` `, line: old_lines[i++] } )
            j++
        } else if( i < old_lines.length && ( j === new_lines.length || common[i + 1][j] >= common[i][j + 1] ) ) {
            // Removals first, so a replaced line reads as - then +
            operations.push( { mark: `-`, line: old_lines[i++] } )
        } else {
            operations.push( { mark: `+`, line: new_lines[j++] } )
        }
    }

    // Keep changes plus their context; collapse the rest
    const changed = operations.map( ( { mark }, index ) => mark === ` ` ? -1 : index ).filter( index => index >= 0 )
    const near_change = index => changed.some( change => Math.abs( change - index ) <= context )
    const colors = { '+': `green`, '-': `red`, ' ': null }

    return operations.flatMap( ( { mark, line }, index ) => {
        // One marker at the start of each skipped stretch
        if( !near_change( index ) ) return index === 0 || near_change( index - 1 ) ? [ paint( `  …`, `dim` ) ] : []
        return [ paint( `${ mark } ${ line }`, colors[ mark ] ) ]
    } )

}

/**
 * Terminal prompts for an interactive audit.
 * @param {string} question - Prompt text
 * @returns {Promise<string>} Trimmed answer
 */
const ask_line = async question => {

    const prompt = createInterface( { input: process.stdin, output: process.stdout } )
    try {
        return ( await prompt.question( question ) ).trim()
    } finally {
        prompt.close()
    }

}

/**
 * Ask for an agent by number or name; never defaults, so a file is never
 * silently given claude.
 * @param {Function} ask - Prompt seam
 * @param {Function} print - Output seam
 * @returns {Promise<string|null>} Agent, or null when skipped with an empty answer
 */
export const pick_agent = async ( ask, print ) => {

    print( SUPPORTED_AGENTS.map( ( agent, index ) => `    ${ index + 1 }) ${ agent }` ).join( `\n` ) )

    // Re-ask until the answer names an agent; empty gives up
    for( ;; ) {
        const answer = ( await ask( `  Agent [1-${ SUPPORTED_AGENTS.length }, empty skips]: ` ) ).toLowerCase()
        if( !answer ) return null
        const agent = SUPPORTED_AGENTS[ Number( answer ) - 1 ] || SUPPORTED_AGENTS.find( name => name === answer )
        if( agent ) return agent
        print( `  Not an agent: ${ answer }` )
    }

}

/**
 * Build a key whose comment block and blank line read like `babysit init`.
 * @param {string} key - Key name
 * @param {string} [comment] - Comment lines, each starting with a space
 * @returns {Scalar}
 */
const commented_key = ( key, comment = KEY_COMMENTS[ key ] ) => {

    const node = new Scalar( key )
    if( comment ) node.commentBefore = comment
    node.spaceBefore = true
    return node

}

// Lists render inline, like `babysit init` writes them
const value_node = ( doc, value ) => {

    const node = doc.createNode( value )
    if( Array.isArray( value ) ) node.flow = true
    if( isMap( node ) ) node.items.forEach( pair => {
        if( pair.value?.items ) pair.value.flow = true
    } )
    return node

}

/**
 * Carry a replaced node's comments onto its replacement, so swapping a bare
 * `launch:  # TODO` for a map does not drop what the person wrote there.
 * They head the new section; key-side comments live on the pair's key and
 * survive a set() untouched.
 * @param {Object|undefined} old - Node being replaced
 * @param {Object} node - Replacement
 * @returns {Object} The replacement
 */
const keep_comments = ( old, node ) => {

    const comments = [ old?.commentBefore, old?.comment ].filter( Boolean )
    if( comments.length ) node.commentBefore = comments.join( `\n` )
    return node

}

/**
 * Put a key into a map at its canonical position (after the closest earlier
 * key in `order` that is present), so inserts never scramble a file.
 * @param {Object} doc - Yaml document
 * @param {Object} map - YAMLMap
 * @param {string|Scalar} key - Key, or a commented key node
 * @param {*} value - Plain value
 * @param {string[]} order - Canonical key order
 */
const insert_in_order = ( doc, map, key, value, order ) => {

    const name = isScalar( key ) ? key.value : key
    const earlier = order.slice( 0, order.indexOf( name ) )
    const positions = map.items.map( ( pair, index ) => earlier.includes( pair.key?.value ) ? index : -1 )
    const after = Math.max( -1, ...positions )
    map.items.splice( after + 1, 0, doc.createPair( key, value_node( doc, value ) ) )

}

/**
 * Audit one yaml in place: list problems, apply fixes, offer optional keys,
 * show the diff, write. Comments and order survive through parseDocument.
 * @param {{ path: string, file: string }} target - Absolute path and display name
 * @param {Object} options
 * @param {boolean} options.interactive - Prompts allowed
 * @param {boolean} options.yes - Apply required fills and fixes without asking; no optionals
 * @param {Function} options.ask - Prompt seam, resolves to the trimmed answer
 * @param {Function} options.print - Output seam
 * @param {Function} [options.write] - File writer seam
 * @returns {Promise<{ file: string, ok: boolean, written: boolean }>} Whether the file passes strict validation afterwards
 */
export const audit_file = async ( { path, file }, { interactive, yes, ask, print, write = writeFileSync } ) => {

    const text = readFileSync( path, `utf-8` )
    const problems = strict_errors( text )
    const doc = parseDocument( text )

    print( `\n${ file }: ${ problems.length ? paint( `${ problems.length } problem${ problems.length === 1 ? `` : `s` }`, `red` ) : paint( `ok`, `green` ) }` )
    problems.forEach( problem => print( `  ✗ ${ problem }` ) )

    // Report-only runs stop here; syntax errors and non-map files need a person
    const result = ok => ( { file, ok, written: false } )
    if( !interactive && !yes ) return result( !problems.length )
    if( doc.errors.length ) return result( false )
    if( doc.contents === null ) doc.contents = doc.createNode( {} )
    if( !isMap( doc.contents ) ) return result( false )

    // y/N per item; --yes accepts fixes but declines optional offers
    const confirm = async ( question, { optional = false } = {} ) => {
        if( yes ) return !optional
        return /^y(es)?$/i.test( await ask( `  ${ question } [y/N] ` ) )
    }

    // The agent is never defaulted: a terminal picks it, anything else reports
    const choose_agent = async reason => {
        if( !interactive ) {
            print( paint( `  launch.agent ${ reason }; run babysit audit in a terminal to pick one`, `red` ) )
            return null
        }
        print( `  launch.agent ${ reason }; pick one:` )
        return pick_agent( ask, print )
    }

    // The launch: section itself
    const top_order = [ `launch`, `config`, `babysit` ]
    let launch = doc.get( `launch`, true )

    // Editing through an alias would rewrite its anchor elsewhere in the file
    if( isAlias( launch ) ) {
        print( paint( `  launch: is an alias; inline it to audit`, `red` ) )
        return result( false )
    }

    if( !isMap( launch ) ) {
        const replace = launch === undefined || isScalar( launch ) && launch.value === null
            || await confirm( `launch: is not a mapping. Replace it with an empty section?` )
        if( !replace ) return result( false )
        if( doc.has( `launch` ) ) doc.set( `launch`, keep_comments( launch, doc.createNode( {} ) ) )
        else insert_in_order( doc, doc.contents, `launch`, {}, top_order )
        launch = doc.get( `launch`, true )
    }

    // Plain values: get() hands back nodes for lists and maps
    const value_of = key => launch.toJSON()[ key ]
    const present = key => launch.has( key ) && value_of( key ) !== null
    const defaults = default_launch()

    // Unknown keys: remove one by one
    for( const pair of [ ...launch.items ] ) {
        const key = pair.key?.value
        if( LAUNCH_KEYS.includes( key ) ) continue
        if( await confirm( `launch.${ key } is not a known key. Remove it?` ) ) launch.delete( key )
    }

    // Invalid values: reset to the default, except agent, which is picked
    for( const key of LAUNCH_KEYS.filter( present ) ) {
        const problem = launch_key_problem( key, value_of( key ) )
        if( !problem ) continue
        const question = key === `agent`
            ? `launch.agent ${ show( value_of( key ) ) } ${ problem }. Pick an agent?`
            : `launch.${ key } ${ show( value_of( key ) ) } ${ problem }. ${ key === `name` ? `Remove it?` : `Reset to ${ show( defaults[ key ] ) }?` }`
        if( !await confirm( question ) ) continue
        if( key === `name` ) launch.delete( key )
        else if( key !== `agent` ) launch.set( key, value_node( doc, defaults[ key ] ) )
        else {
            const agent = await choose_agent( `is invalid` )
            if( agent ) launch.set( key, agent )
        }
    }

    // Required keys: defaults go in without asking, the agent is always chosen
    for( const key of LAUNCH_KEYS.filter( key => key !== `name` && !present( key ) ) ) {
        const value = key === `agent` ? await choose_agent( `is missing` ) : defaults[ key ]
        if( value === null ) continue
        if( launch.has( key ) ) launch.set( key, value_node( doc, value ) )
        else insert_in_order( doc, launch, key, value, LAUNCH_KEYS )
    }

    // Cross-key rule: clone needs regular mode
    const { launch: settled } = validate_launch( launch.toJSON() )
    if( settled.clone && settled.mode !== `regular` && await confirm( `launch.clone cannot be combined with mode: ${ settled.mode }. Set clone: false?` ) ) {
        launch.set( `clone`, false )
    }

    // Optional offers, interactive only
    if( !yes ) {

        const name = launch_name_for( file )
        if( !present( `name` ) && await confirm( `Add launch.name: ${ show( name ) } (the name directory launches use)?`, { optional: true } ) ) {
            insert_in_order( doc, launch, `name`, name, LAUNCH_KEYS )
        }

        // config: is created on the first accepted offer, right after launch:
        const config_map = () => {
            if( !isMap( doc.get( `config`, true ) ) ) {
                if( doc.has( `config` ) ) doc.set( `config`, doc.createNode( {} ) )
                else insert_in_order( doc, doc.contents, commented_key( `config`, ` Supervision settings; unset keys use the defaults.` ), {}, top_order )
            }
            return doc.get( `config`, true )
        }
        const config_has = key => isMap( doc.get( `config`, true ) ) && doc.getIn( [ `config`, key ] ) !== undefined
        const add_config = ( key, value ) => {
            const map = config_map()
            const node = value_node( doc, value )
            // The prompt reads best as a literal block, like `babysit init` writes it
            if( key === `initial_prompt` ) node.type = Scalar.BLOCK_LITERAL
            // No blank line right under a fresh `config:`
            const key_node = commented_key( key )
            key_node.spaceBefore = map.items.length > 0
            map.items.push( doc.createPair( key_node, node ) )
        }

        for( const key of TUNING_KEYS.filter( key => !config_has( key ) ) ) {
            // Absence means the generated, mode-aware prompt; writing it pins today's text
            const question = key === `initial_prompt`
                ? `Add config.initial_prompt (pins the generated prompt; leaving it out follows each session's mode)?`
                : `Add config.${ key }: ${ show( DEFAULT_CONFIG[ key ] ) }?`
            if( await confirm( question, { optional: true } ) ) add_config( key, key === `initial_prompt` ? build_system_prompt( {} ) : DEFAULT_CONFIG[ key ] )
        }

        if( launch.get( `clone` ) === true && !config_has( `clone` ) && await confirm( `Add a config.clone: section with the defaults?`, { optional: true } ) ) {
            add_config( `clone`, DEFAULT_CLONE_CONFIG )
        }

        if( !config_has( `commands` ) && await confirm( `Add an empty config.commands: map (with an example comment)?`, { optional: true } ) ) {
            add_config( `commands`, {} )
        }

        if( !doc.has( `babysit` ) && await confirm( `Add an empty babysit: rule list (with the rule syntax as comments)?`, { optional: true } ) ) {
            insert_in_order( doc, doc.contents, commented_key( `babysit` ), [], top_order )
        }

    }

    // Show the diff and write
    const updated = doc.toString( { indent: yaml_indent( text ), lineWidth: 0 } )
    const remaining = strict_errors( updated )
    const passes = !remaining.length
    if( updated === text ) {
        if( problems.length ) print( `  Nothing changed.` )
        return result( passes )
    }

    print( `` )
    line_diff( text, updated ).forEach( line => print( `  ${ line }` ) )
    print( `` )
    if( !passes ) print( paint( `  Still failing after these changes: ${ remaining.join( `; ` ) }`, `yellow` ) )

    const approved = yes || !/^n(o)?$/i.test( await ask( `  Write ${ file }? [Y/n] ` ) )
    if( !approved ) {
        print( `  Not written.` )
        return result( !problems.length )
    }

    write( path, updated, `utf-8` )
    print( `  Wrote ${ file }` )
    return { file, ok: passes, written: true }

}

/**
 * `babysit audit --config FILE|DIR/`: bring yaml files up to what a directory
 * launch requires. Non-interactive runs only report; `--yes` applies required
 * fills and per-item fixes, skipping optional offers.
 * @param {Object} cmd - Parsed command; `flags.config` is FILE or DIR, `flags.yes`
 * @param {Object} [deps] - Injectable seams
 * @returns {Promise<number>} Exit code: 0 when every file passes afterwards
 */
export const cmd_audit = async ( { flags = {} } = {}, {
    ask = ask_line,
    print = console.log,
    write = writeFileSync,
    interactive = Boolean( process.stdin.isTTY && process.stdout.isTTY ),
} = {} ) => {

    if( !flags.config ) throw new Error( `babysit audit needs --config FILE or --config DIR/` )

    const { base, files } = audit_targets( flags.config )
    if( !files.length ) throw new Error( `No .yaml or .yml files in ${ flags.config }` )

    // One file at a time: prompts read top to bottom
    const results = []
    for( const path of files ) {
        results.push( await audit_file( { path, file: relative( base, path ) }, { interactive, yes: flags.yes, ask, print, write } ) )
    }

    const failing = results.filter( ( { ok } ) => !ok )
    print( `` )
    print( failing.length
        ? paint( `${ failing.length } of ${ results.length } failing: ${ failing.map( ( { file } ) => file ).join( `, ` ) }`, `red` )
        : paint( `All ${ results.length } file${ results.length === 1 ? `` : `s` } pass.`, `green` ) )
    if( failing.length && !interactive && !flags.yes ) print( `Run babysit audit in a terminal to fix them, or add --yes for the required fixes.` )

    return failing.length ? 1 : 0

}
