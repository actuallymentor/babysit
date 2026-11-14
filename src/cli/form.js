import { emitKeypressEvents } from 'readline'

/**
 * A few text fields on the alternate screen, styled like the launch menu.
 * ↑/↓ (or Tab) move, typing edits, Enter goes to the next field and submits
 * on the last one, Esc cancels. Secret fields show bullets, never the text.
 * @param {Object} options
 * @param {string} options.title - Heading above the fields
 * @param {{ key: string, label: string, value?: string, hint?: string, secret?: boolean }[]} options.fields
 * @param {Function} [options.validate] - Gets the values, throws to refuse; the message shows under the form
 * @param {string} [options.submit=`save`] - What the last Enter does, for the key hint
 * @param {string[]} [options.notes] - Lines under the key hint, e.g. setup steps
 * @returns {Promise<Object|null>} `{ key: value }`, or null when cancelled
 */
export const form_menu = async ( {
    title, fields, validate = () => {}, submit = `save`, notes = [], input = process.stdin, output = process.stdout,
} ) => {

    if( !input.isTTY || !output.isTTY || typeof input.setRawMode !== `function` ) {
        throw new Error( `This form needs an interactive terminal` )
    }

    const values = Object.fromEntries( fields.map( ( { key, value = `` } ) => [ key, value ] ) )
    const cursors = Object.fromEntries( fields.map( ( { key } ) => [ key, Array.from( values[ key ] ).length ] ) )
    const width = Math.max( ...fields.map( ( { label } ) => label.length ) ) + 2

    // Start on the first empty field, so prefilled ones are a single Enter away
    let row = Math.max( 0, fields.findIndex( ( { key } ) => !values[ key ] ) )
    let error = ``
    const was_raw = Boolean( input.isRaw )
    const was_flowing = input.readableFlowing === true

    const render = () => {

        const rows = fields.map( ( { key, label, hint = ``, secret }, index ) => {
            const letters = Array.from( secret ? `•`.repeat( Array.from( values[ key ] ).length ) : values[ key ] )
            const shown = index === row
                ? [ ...letters.slice( 0, cursors[ key ] ), `│`, ...letters.slice( cursors[ key ] ) ].join( `` )
                : letters.join( `` ) || hint
            return `${ index === row ? `›` : ` ` } ${ label.padEnd( width ) }${ shown }`
        } )

        const lines = [
            title,
            ``,
            ...rows,
            ``,
            `↑/↓ move · Enter ${ row === fields.length - 1 ? submit : `next` } · Esc cancel`,
            ...error ? [ error ] : [],
        ]

        // Truncate the form so it never wraps; notes sit below it and may wrap (they are meant to be copied whole)
        const columns = Math.max( 1, ( output.columns || 80 ) - 1 )
        const form = lines.map( line => Array.from( line ).slice( 0, columns ).join( `` ) )
        output.write( `\x1b[H\x1b[2J${ [ ...form, ...notes.length ? [ ``, ...notes ] : [] ].join( `\r\n` ) }` )

    }

    emitKeypressEvents( input )
    let handle_key
    let handle_end
    let raw_changed = false

    try {
        output.write( `\x1b[?1049h\x1b[?25l` )
        input.setRawMode( true )
        raw_changed = true
        input.resume()

        return await new Promise( resolve => {

            handle_end = () => resolve( null )
            handle_key = ( chars, key = {} ) => {

                if( key.name === `escape` || key.ctrl && key.name === `c` ) return resolve( null )

                error = ``
                const { key: field } = fields[ row ]

                if( key.name === `return` && row < fields.length - 1 ) row++
                else if( key.name === `return` ) {
                    try {
                        validate( { ...values } )
                        return resolve( { ...values } )
                    } catch ( failure ) {
                        error = failure.message
                    }
                } else if( key.name === `up` ) row = ( row + fields.length - 1 ) % fields.length
                else if( key.name === `down` || key.name === `tab` ) row = ( row + 1 ) % fields.length
                else {
                    const letters = Array.from( values[ field ] )
                    let cursor = cursors[ field ]
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
                    values[ field ] = letters.join( `` )
                    cursors[ field ] = cursor
                }
                render()

            }

            input.on( `keypress`, handle_key )
            input.on( `end`, handle_end )
            output.on( `resize`, render )
            render()

        } )
    } finally {
        if( handle_key ) input.removeListener( `keypress`, handle_key )
        if( handle_end ) input.removeListener( `end`, handle_end )
        output.removeListener( `resize`, render )
        try {
            if( raw_changed ) input.setRawMode( was_raw )
        } finally {
            if( !was_flowing ) input.pause()
            output.write( `\x1b[?25h\x1b[?1049l` )
        }
    }

}
