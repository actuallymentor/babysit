import { emitKeypressEvents } from 'readline'

import { SUPPORTED_AGENTS } from '../agents/index.js'
import { read_launch_defaults } from '../babysit/launch_defaults.js'
import { parse_args } from './parse.js'

const MODES = [ `regular`, `sandbox`, `mudbox` ]
const TOGGLES = [ `docker`, `yolo`, `clone`, `loop` ]
const ROW_COUNT = 7

const cycle = ( choices, value, direction ) =>
    choices[ ( choices.indexOf( value ) + direction + choices.length ) % choices.length ]

/**
 * Select a launch using arrow keys, editable name, and Space toggles.
 * @param {Object} [options] - Initial name, terminal streams, and defaults location
 * @returns {Promise<Object|null>} Parsed launch, or null when cancelled
 */
export const launch_menu = async ( {
    name = ``, input = process.stdin, output = process.stdout, ...defaults_options
} = {} ) => {

    if( !input.isTTY || !output.isTTY || typeof input.setRawMode !== `function` ) {
        throw new Error( `The launch menu requires an interactive terminal. Use babysit <agent> [flags], or babysit --help.` )
    }

    const state = { ...read_launch_defaults( defaults_options ), name }
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
            ...TOGGLES.map( flag => `[${ state[ flag ] ? `x` : ` ` }] ${ flag === `yolo` ? `YOLO` : flag[0].toUpperCase() + flag.slice( 1 ) }` ),
            `Mode    ‹ ${ state.mode } ›`,
        ]
        const lines = [
            ...rows.map( ( text, index ) => `${ index === row ? `›` : ` ` } ${ text }` ),
            ``,
            `↑/↓ move · ←/→ choose · Space toggle · Enter launch · Esc cancel`,
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
                } else if( ( row === 0 || row === 6 ) && [ `left`, `right` ].includes( key.name ) ) {
                    const field = row === 0 ? `agent` : `mode`
                    state[ field ] = cycle( row === 0 ? SUPPORTED_AGENTS : MODES, state[ field ], key.name === `right` ? 1 : -1 )
                    if( state.mode !== `regular` ) state.clone = false
                } else if( row >= 2 && row <= 5 && key.name === `space` ) {
                    const flag = TOGGLES[ row - 2 ]
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
