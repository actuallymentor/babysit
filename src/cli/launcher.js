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
const TOGGLES = [ `docker`, `adb`, `ios`, `yolo`, `clone`, `loop` ]
const LABELS = { adb: `ADB`, ios: `iOS`, yolo: `YOLO` }

// Rows: model, name, one per toggle, then mode.
const FIRST_TOGGLE_ROW = 2
const MODE_ROW = FIRST_TOGGLE_ROW + TOGGLES.length
const ROW_COUNT = MODE_ROW + 1

const cycle = ( choices, value, direction ) =>
    choices[ ( choices.indexOf( value ) + direction + choices.length ) % choices.length ]

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

    const state = { ...read_launch_defaults( defaults_options ), ...initial, name }
    if( state.mode !== `regular` ) state.clone = false
    let row = 0
    let cursor = Array.from( name ).length
    let error = ``
    const was_raw = Boolean( input.isRaw )
    const was_flowing = input.readableFlowing === true

    const render = () => {

        const letters = Array.from( state.name )
        const name_value = row === 1
            ? [ ...letters.slice( 0, cursor ), `│`, ...letters.slice( cursor ) ].join( `` )
            : state.name || `(optional)`
        const rows = [
            `Model   ‹ ${ state.agent } ›`,
            `Name    ${ name_value }`,
            ...TOGGLES.map( flag => `[${ state[ flag ] ? `x` : ` ` }] ${ LABELS[ flag ] || flag[0].toUpperCase() + flag.slice( 1 ) }` ),
            `Mode    ‹ ${ state.mode } ›`,
        ]
        const lines = [
            ...rows.map( ( text, index ) => `${ index === row ? `›` : ` ` } ${ text }` ),
            ``,
            `↑/↓ move · ←/→ choose · Space toggle · Enter ${ submit }${ fork_key ? ` · f fork a session` : `` } · Esc cancel`,
            error,
        ]
        // Redraw the alternate screen; truncate rows to avoid terminal wrapping.
        const width = Math.max( 1, ( output.columns || 80 ) - 1 )
        output.write( `\x1b[H\x1b[2J${ lines.map( line => Array.from( line ).slice( 0, width ).join( `` ) ).join( `\r\n` ) }` )

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
            handle_key = ( text, key = {} ) => {

                if( key.name === `escape` || key.ctrl && key.name === `c` ) return resolve( null )
                // `f` types into the name row; everywhere else it switches to forking
                if( fork_key && row !== 1 && text === `f` ) return resolve( { verb: `fork_menu` } )
                if( key.name === `return` ) {
                    try {
                        const argv = [ state.agent, ...TOGGLES.filter( flag => state[ flag ] ).map( flag => `--${ flag }` ) ]
                        if( state.mode !== `regular` ) argv.push( `--${ state.mode }` )
                        if( state.name.trim() ) argv.push( `--name=${ state.name }` )
                        return resolve( parse_args( argv ) )
                    } catch ( failure ) {
                        error = failure.message
                        render()
                        return
                    }
                }

                error = ``
                if( key.name === `up` ) row = ( row + ROW_COUNT - 1 ) % ROW_COUNT
                else if( key.name === `down` || key.name === `tab` ) row = ( row + 1 ) % ROW_COUNT
                else if( row === 1 ) {
                    const letters = Array.from( state.name )
                    if( key.name === `left` ) cursor = Math.max( 0, cursor - 1 )
                    else if( key.name === `right` ) cursor = Math.min( letters.length, cursor + 1 )
                    else if( key.name === `home` ) cursor = 0
                    else if( key.name === `end` ) cursor = letters.length
                    else if( key.name === `backspace` && cursor ) letters.splice( --cursor, 1 )
                    else if( key.name === `delete` ) letters.splice( cursor, 1 )
                    else if( text && !key.ctrl && !key.meta && !/[\u0000-\u001f\u007f]/.test( text ) ) {
                        letters.splice( cursor, 0, ...Array.from( text ) )
                        cursor += Array.from( text ).length
                    }
                    state.name = letters.join( `` )
                } else if( ( row === 0 || row === MODE_ROW ) && [ `left`, `right` ].includes( key.name ) ) {
                    const field = row === 0 ? `agent` : `mode`
                    state[ field ] = cycle( row === 0 ? SUPPORTED_AGENTS : MODES, state[ field ], key.name === `right` ? 1 : -1 )
                    if( state.mode !== `regular` ) state.clone = false
                } else if( row >= FIRST_TOGGLE_ROW && row < MODE_ROW && key.name === `space` ) {
                    const flag = TOGGLES[ row - FIRST_TOGGLE_ROW ]
                    state[ flag ] = !state[ flag ]
                    if( flag === `clone` && state.clone ) state.mode = `regular`
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
 * Open the launch menu prefilled from a config file's `launch:` section.
 * Keys the menu has no row for (ports, log, args, ignore_host_agents_md)
 * are carried into the launch unchanged.
 * @param {Object} [options]
 * @param {string} [options.name] - Name typed on the command line; wins over the file
 * @param {string|false} [options.config] - Absolute --config file
 * @param {Object} [options.flags] - Flags typed on the command line: switches prefill the menu, ports and log carry through
 * @param {Function} [options.menu] - Menu seam
 * @returns {Promise<Object|null>} Parsed start command, or null when cancelled
 */
export const launch_from_menu = async ( { name = ``, config = false, flags = {}, menu = launch_menu, fork = fork_from_menu } = {} ) => {

    const declared = config ? read_declared_launch( config ) : {}
    const pick = keys => Object.fromEntries( keys.filter( key => Object.hasOwn( declared, key ) ).map( key => [ key, declared[ key ] ] ) )

    // Typed switches beat the file and the remembered defaults, so `babysit --yolo` opens with yolo on
    const typed = {
        ...Object.fromEntries( TOGGLES.filter( flag => flags[ flag ] ).map( flag => [ flag, true ] ) ),
        ...flags.sandbox ? { mode: `sandbox` } : flags.mudbox ? { mode: `mudbox` } : {},
    }

    const chosen = await menu( { name: name || declared.name || ``, initial: { ...pick( [ `agent`, `mode`, ...TOGGLES ] ), ...typed }, fork_key: true } )
    if( !chosen ) return null
    if( chosen.verb === `fork_menu` ) return fork( { menu } )

    // The menu's choice wins for its rows; the rest come from the file as-is
    const carried = {
        ...pick( [ `ports`, `log`, `args`, `ignore_host_agents_md` ] ),
        ...flags.ports?.length ? { ports: flags.ports } : {},
        ...typeof flags.log === `string` ? { log: flags.log || true } : {},
        ...flags.ignore_host_agents_md ? { ignore_host_agents_md: true } : {},
    }
    return launch_to_command( { ...command_to_launch( chosen ), ...carried }, { config_path: config || null } )

}
