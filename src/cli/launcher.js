import { emitKeypressEvents } from 'readline'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { read_launch_defaults } from '../babysit/launch_defaults.js'
import { command_to_launch, launch_to_command, read_launch_section, validate_launch } from '../babysit/launch_config.js'
import { log } from '../utils/log.js'
import { list_sessions } from '../tmux/session.js'
import { list_stored_sessions } from '../sessions/store.js'
import { FORK_NEGATABLE_FLAGS, parse_args } from './parse.js'
import { fork_tree_prefixes, order_active_sessions, stored_by_tmux } from './list.js'
import { default_fork_filesystem, merge_fork_flags } from './fork.js'

const MODES = [ `regular`, `sandbox`, `mudbox` ]

// Top-level switches: the only ones the menu remembers per project
const TOGGLES = [ `docker`, `devices`, `yolo`, `clone`, `loop` ]

// Behind Advanced: never remembered, prefilled only from flags, --config or a fork's parent
const ADVANCED_TOGGLES = [ `adb`, `ios`, `ignore_host_agents_md` ]
const ADVANCED_TEXT = [ `ports`, `log`, `args` ]

const LABELS = { adb: `ADB`, ios: `iOS`, yolo: `YOLO`, devices: `Devices`, ignore_host_agents_md: `Ignore host AGENTS.md` }
const TEXT_LABELS = { name: `Name`, ports: `Ports`, log: `Log`, args: `Args` }
const TEXT_HINTS = { name: `(optional)`, ports: `(e.g. 5173, 3000:80)`, log: `(off; "on" for the default path)`, args: `(agent arguments, e.g. --model opus)` }

const cycle = ( choices, value, direction ) =>
    choices[ ( choices.indexOf( value ) + direction + choices.length ) % choices.length ]

// Split a typed line into words, keeping "quoted phrases" together
const words = text => ( text.match( /"[^"]*"|'[^']*'|\S+/g ) || [] ).map( word => word.replace( /^(["'])(.*)\1$/, `$2` ) )

// Launch-section values as the text a row shows
const as_text = {
    ports: value => Array.isArray( value ) ? value.join( `, ` ) : value || ``,
    log: value => value === true ? `on` : value || ``,
    args: value => Array.isArray( value ) ? value.map( arg => /\s/.test( arg ) ? JSON.stringify( arg ) : arg ).join( ` ` ) : value || ``,
}

/**
 * Select a launch using arrow keys, editable name, and Space toggles.
 * @param {Object} [options] - Initial name and values, terminal streams, and defaults location
 * @param {Object} [options.initial] - Menu values that override the remembered defaults
 * @param {string} [options.submit] - What Enter does, for the key hint
 * @param {boolean} [options.fork_key=false] - Offer `f` to fork a running session instead
 * @returns {Promise<Object|null>} Parsed launch, `{ verb: 'fork_menu' }`, or null when cancelled
 */
export const launch_menu = async ( {
    name = ``, initial = {}, submit = `launch`, fork_key = false, input = process.stdin, output = process.stdout, ...defaults_options
} = {} ) => {

    if( !input.isTTY || !output.isTTY || typeof input.setRawMode !== `function` ) {
        throw new Error( `The launch menu requires an interactive terminal. Use babysit <agent> [flags], or babysit --help.` )
    }

    const state = { ...read_launch_defaults( defaults_options ), ...initial }
    if( state.mode !== `regular` ) state.clone = false

    // Text rows keep their own value and cursor; Advanced starts open only when it was prefilled
    const text = { name, ports: as_text.ports( initial.ports ), log: as_text.log( initial.log ), args: as_text.args( initial.args ) }
    const cursors = Object.fromEntries( Object.entries( text ).map( ( [ key, value ] ) => [ key, Array.from( value ).length ] ) )
    let open = [ ...ADVANCED_TOGGLES, ...ADVANCED_TEXT ].some( key => initial[ key ] )
    let row = 0
    let error = ``
    const was_raw = Boolean( input.isRaw )
    const was_flowing = input.readableFlowing === true

    // A fork takes its agent arguments from the parent, so it has no Args row
    const advanced_text = ADVANCED_TEXT.filter( key => key !== `args` || submit !== `fork` )
    const visible_rows = () => [
        { type: `cycle`, key: `agent` },
        { type: `text`, key: `name` },
        ...TOGGLES.map( key => ( { type: `toggle`, key } ) ),
        { type: `cycle`, key: `mode` },
        { type: `expand` },
        ...open ? [
            ...ADVANCED_TOGGLES.map( key => ( { type: `toggle`, key } ) ),
            ...advanced_text.map( key => ( { type: `text`, key } ) ),
        ] : [],
    ]

    const render = () => {

        const rows = visible_rows().map( ( { type, key }, index ) => {
            if( type === `cycle` ) return `${ key === `agent` ? `Model` : `Mode ` }   ‹ ${ state[ key ] } ›`
            if( type === `expand` ) return `Advanced ${ open ? `▾` : `▸` }`
            if( type === `toggle` ) return `${ open && ADVANCED_TOGGLES.includes( key ) ? `  ` : `` }[${ state[ key ] ? `x` : ` ` }] ${ LABELS[ key ] || key[0].toUpperCase() + key.slice( 1 ) }`
            const letters = Array.from( text[ key ] )
            const value = index === row
                ? [ ...letters.slice( 0, cursors[ key ] ), `│`, ...letters.slice( cursors[ key ] ) ].join( `` )
                : text[ key ] || TEXT_HINTS[ key ]
            return `${ ADVANCED_TEXT.includes( key ) ? `  ` : `` }${ TEXT_LABELS[ key ].padEnd( 8 ) }${ value }`
        } )
        const lines = [
            ...rows.map( ( line, index ) => `${ index === row ? `›` : ` ` } ${ line }` ),
            ``,
            `↑/↓ move · ←/→ choose · Space toggle · Enter ${ submit }${ fork_key ? ` · f fork a session` : `` } · Esc cancel`,
            error,
        ]
        // Redraw the alternate screen; truncate rows to avoid terminal wrapping.
        const width = Math.max( 1, ( output.columns || 80 ) - 1 )
        output.write( `\x1b[H\x1b[2J${ lines.map( line => Array.from( line ).slice( 0, width ).join( `` ) ).join( `\r\n` ) }` )

    }

    // The command line the menu stands for; bad values throw and show under the menu
    const to_command = () => {
        const argv = [ state.agent, ...[ ...TOGGLES, ...ADVANCED_TOGGLES ].filter( flag => state[ flag ] ).map( flag => `--${ flag.replaceAll( `_`, `-` ) }` ) ]
        if( state.mode !== `regular` ) argv.push( `--${ state.mode }` )
        if( text.name.trim() ) argv.push( `--name=${ text.name }` )
        for( const port of text.ports.split( /[,\s]+/ ).filter( Boolean ) ) argv.push( `--port=${ port }` )
        if( text.log.trim() ) argv.push( text.log.trim() === `on` ? `--log=` : `--log=${ text.log.trim() }` )

        // Agent arguments skip Babysit's parser so they can never be read as Babysit flags
        return { ...parse_args( argv ), passthrough: submit === `fork` ? [] : words( text.args ) }
    }

    emitKeypressEvents( input )
    let handle_key
    let handle_end
    let handle_error
    let raw_changed = false

    try {
        output.write( `\x1b[?1049h\x1b[?25l` )
        input.setRawMode( true )
        raw_changed = true
        input.resume()

        return await new Promise( ( resolve, reject ) => {

            handle_end = () => resolve( null )
            handle_error = reject
            handle_key = ( chars, key = {} ) => {

                const rows = visible_rows()
                const current = rows[ row ]

                if( key.name === `escape` || key.ctrl && key.name === `c` ) return resolve( null )
                // `f` types into text rows; everywhere else it switches to forking
                if( fork_key && current.type !== `text` && chars === `f` ) return resolve( { verb: `fork_menu` } )
                if( key.name === `return` ) {
                    try {
                        return resolve( to_command() )
                    } catch ( failure ) {
                        error = failure.message
                        render()
                        return
                    }
                }

                error = ``
                if( key.name === `up` ) row = ( row + rows.length - 1 ) % rows.length
                else if( key.name === `down` || key.name === `tab` ) row = ( row + 1 ) % rows.length
                else if( current.type === `text` ) {
                    const letters = Array.from( text[ current.key ] )
                    let cursor = cursors[ current.key ]
                    if( key.name === `left` ) cursor = Math.max( 0, cursor - 1 )
                    else if( key.name === `right` ) cursor = Math.min( letters.length, cursor + 1 )
                    else if( key.name === `home` ) cursor = 0
                    else if( key.name === `end` ) cursor = letters.length
                    else if( key.name === `backspace` && cursor ) letters.splice( --cursor, 1 )
                    else if( key.name === `delete` ) letters.splice( cursor, 1 )
                    else if( chars && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test( chars ) ) {
                        letters.splice( cursor, 0, ...Array.from( chars ) )
                        cursor += Array.from( chars ).length
                    }
                    text[ current.key ] = letters.join( `` )
                    cursors[ current.key ] = cursor
                } else if( current.type === `cycle` && [ `left`, `right` ].includes( key.name ) ) {
                    state[ current.key ] = cycle( current.key === `agent` ? SUPPORTED_AGENTS : MODES, state[ current.key ], key.name === `right` ? 1 : -1 )
                    if( state.mode !== `regular` ) state.clone = false
                } else if( current.type === `expand` && [ `space`, `left`, `right` ].includes( key.name ) ) {
                    open = key.name === `left` ? false : key.name === `right` ? true : !open
                } else if( current.type === `toggle` && key.name === `space` ) {
                    state[ current.key ] = !state[ current.key ]
                    if( current.key === `clone` && state.clone ) state.mode = `regular`
                }
                render()

            }

            input.on( `keypress`, handle_key )
            input.on( `end`, handle_end )
            input.on( `error`, handle_error )
            output.on( `resize`, render )
            render()

        } )
    } finally {
        if( handle_key ) input.removeListener( `keypress`, handle_key )
        if( handle_end ) input.removeListener( `end`, handle_end )
        if( handle_error ) input.removeListener( `error`, handle_error )
        output.removeListener( `resize`, render )
        try {
            if( raw_changed ) input.setRawMode( was_raw )
        } finally {
            if( !was_flowing ) input.pause()
            output.write( `\x1b[?25h\x1b[?1049l` )
        }
    }

}

/**
 * Pick one line with ↑/↓ and Enter; Esc cancels.
 * @param {Object} options
 * @param {string} options.title - Heading above the choices
 * @param {string[]} options.choices - One line per choice
 * @param {NodeJS.ReadStream} [options.input=process.stdin] - Raw-capable TTY
 * @param {NodeJS.WriteStream} [options.output=process.stdout] - Terminal
 * @returns {Promise<number|null>} Chosen index, or null
 */
export const pick_from_list = async ( { title, choices, input = process.stdin, output = process.stdout } ) => {

    let row = 0
    const was_raw = Boolean( input.isRaw )
    const was_flowing = input.readableFlowing === true
    const width = () => Math.max( 1, ( output.columns || 80 ) - 1 )
    const render = () => output.write( `\x1b[H\x1b[2J${ [
        title,
        ``,
        ...choices.map( ( choice, index ) => `${ index === row ? `›` : ` ` } ${ choice }` ),
        ``,
        `↑/↓ move · Enter choose · Esc cancel`,
    ].map( line => Array.from( line ).slice( 0, width() ).join( `` ) ).join( `\r\n` ) }` )

    emitKeypressEvents( input )
    let handle_key
    let handle_end
    try {
        output.write( `\x1b[?1049h\x1b[?25l` )
        input.setRawMode( true )
        input.resume()
        return await new Promise( resolve => {
            handle_end = () => resolve( null )
            handle_key = ( _, key = {} ) => {
                if( key.name === `escape` || key.ctrl && key.name === `c` ) return resolve( null )
                if( key.name === `return` ) return resolve( row )
                if( key.name === `up` ) row = ( row + choices.length - 1 ) % choices.length
                if( key.name === `down` || key.name === `tab` ) row = ( row + 1 ) % choices.length
                render()
            }
            input.on( `keypress`, handle_key )
            input.on( `end`, handle_end )
            render()
        } )
    } finally {
        if( handle_key ) input.removeListener( `keypress`, handle_key )
        if( handle_end ) input.removeListener( `end`, handle_end )
        input.setRawMode( was_raw )
        if( !was_flowing ) input.pause()
        output.write( `\x1b[?25h\x1b[?1049l` )
    }

}

/**
 * Turn a launch-menu choice into the fork command for a parent. The menu
 * shows the complete state, so every switch it leaves off is unset too.
 * @param {Object} parent - Parent session record
 * @param {Object} chosen - parse_args result of the menu (a start command)
 * @returns {Object} Parsed `fork` command
 */
export const fork_command_from_menu = ( parent, chosen ) => {

    const { flags } = chosen
    const regular = !flags.sandbox && !flags.mudbox

    return {
        verb: `fork`,
        agent: chosen.agent,
        session_id: parent.babysit_id,
        flags: {
            ...flags,
            regular,
            // The Clone toggle answers the filesystem question for a regular fork
            clone: regular && flags.clone,
            share: regular && !flags.clone,
            history: true,
            takeover: false,
            unset: FORK_NEGATABLE_FLAGS.filter( flag => !flags[ flag ] ),
        },
        passthrough: [],
    }

}

/**
 * Launcher fork action: pick a listed session, then adjust the fork in the
 * normal menu, prefilled from the parent (Clone checked when that is the default).
 * @param {Object} [options] - Seams for tests
 * @returns {Promise<Object|null>} Parsed `fork` command, or null when cancelled
 */
export const fork_from_menu = async ( {
    menu = launch_menu,
    pick = pick_from_list,
    list_sessions_fn = list_sessions,
    list_stored_sessions_fn = list_stored_sessions,
} = {} ) => {

    const stored = list_stored_sessions_fn()
    const live = await list_sessions_fn()
    const by_tmux = stored_by_tmux( stored )
    const rows = order_active_sessions( live, stored )
        .map( ( row, index ) => ( { row, number: index + 1, parent: by_tmux.get( row.name ) } ) )
        .filter( ( { parent } ) => parent )
    if( !rows.length ) throw new Error( `No sessions to fork. Start one with babysit <agent>.` )

    const { prefixes } = fork_tree_prefixes( rows.map( ( { row } ) => row ), stored )
    const index = await pick( {
        title: `Fork which session?`,
        choices: rows.map( ( { row, number, parent }, position ) =>
            `${ String( number ).padStart( 2 ) }  ${ prefixes[ position ] }${ parent.name || parent.babysit_id }  ${ parent.agent }${ row.exited ? `  (exited)` : `` }` ),
    } )
    if( index === null ) return null

    const { row, parent } = rows[ index ]
    const inherited = merge_fork_flags( parent, {}, rows.map( ( { parent: { name } } ) => name ).filter( Boolean ) )
    const mode = inherited.sandbox ? `sandbox` : inherited.mudbox ? `mudbox` : `regular`
    const filesystem = default_fork_filesystem( { parent_live: !row.exited, parent_stuck: Boolean( parent.stuck_at ), flags: inherited } )

    const chosen = await menu( {
        name: inherited.name || ``,
        initial: {
            agent: parent.agent,
            mode,
            ...Object.fromEntries( TOGGLES.map( flag => [ flag, Boolean( inherited[ flag ] ) ] ) ),
            // Both device kinds are the Devices switch; a lone kind sits under Advanced
            devices: Boolean( inherited.adb && inherited.ios ),
            adb: Boolean( inherited.adb && !inherited.ios ),
            ios: Boolean( inherited.ios && !inherited.adb ),
            ignore_host_agents_md: Boolean( inherited.ignore_host_agents_md ),
            clone: filesystem === `clone`,
        },
        submit: `fork`,
    } )
    if( !chosen ) return null

    return fork_command_from_menu( parent, chosen )

}

// Valid `launch:` keys a config file sets; problems warn and fall back to the menu
const read_declared_launch = config => {
    try {
        const { declared, errors } = validate_launch( read_launch_section( config ) )
        errors.forEach( error => log.warn( `${ config }: ${ error }; using the menu default` ) )
        return declared
    } catch {
        // A missing or unparsable file is reported by load_config at launch
        return {}
    }
}

/**
 * Open the launch menu prefilled from a config file's `launch:` section and
 * from the flags typed on the command line (which win).
 * @param {Object} [options]
 * @param {string} [options.name] - Name typed on the command line; wins over the file
 * @param {string|false} [options.config] - Absolute --config file
 * @param {Object} [options.flags] - Flags typed on the command line
 * @param {Function} [options.menu] - Menu seam
 * @returns {Promise<Object|null>} Parsed start command, or null when cancelled
 */
export const launch_from_menu = async ( { name = ``, config = false, flags = {}, menu = launch_menu, fork = fork_from_menu } = {} ) => {

    const declared = config ? read_declared_launch( config ) : {}
    const pick = keys => Object.fromEntries( keys.filter( key => Object.hasOwn( declared, key ) ).map( key => [ key, declared[ key ] ] ) )

    // --devices expands to adb + ios when parsed; show it as the one switch the user typed
    const typed_toggles = [ ...TOGGLES, ...ADVANCED_TOGGLES ].filter( flag => flags[ flag ] && !( flags.devices && [ `adb`, `ios` ].includes( flag ) ) )
    const typed = {
        ...Object.fromEntries( typed_toggles.map( flag => [ flag, true ] ) ),
        ...flags.sandbox ? { mode: `sandbox` } : flags.mudbox ? { mode: `mudbox` } : {},
        ...flags.ports?.length ? { ports: flags.ports } : {},
        ...typeof flags.log === `string` ? { log: flags.log || true } : {},
    }

    const keys = [ `agent`, `mode`, ...TOGGLES, ...ADVANCED_TOGGLES, ...ADVANCED_TEXT ]
    const chosen = await menu( { name: name || declared.name || ``, initial: { ...pick( keys ), ...typed }, fork_key: true } )
    if( !chosen ) return null
    if( chosen.verb === `fork_menu` ) return fork( { menu } )

    // Every launch key has a row now, so the menu's choice is the whole launch
    return launch_to_command( command_to_launch( chosen ), { config_path: config || null } )

}
