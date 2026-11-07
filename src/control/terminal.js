import { get_agent } from '../agents/index.js'
import { strip_ansi } from '../babysit/matcher.js'
import { pending, unsupported } from './terminal_kit.js'

const DEFAULT_TIMEOUT_MS = 8_000

// After each turn Claude pre-fills its composer with a dim suggested prompt.
// Plain captures cannot tell that from typing, so drop dim runs from a styled one.
const without_ghost_text = styled => {
    const lines = styled.split( `\n` )
    const plain = line => strip_ansi( line.replace( /\x1b\[[0-9:;]*m/g, `` ) )
    const start = lines.findLastIndex( line => plain( line ).startsWith( `❯` ) )
    const end = lines.findIndex( ( line, index ) => index > start && plain( line ).startsWith( `──` ) )
    if( start < 0 || end < 0 ) return strip_ansi( styled )
    // Track intensity across colour changes and wrapped rows, but remove text
    // only inside the composer. A dim border/cursor still defines its bounds.
    let dim = false
    return strip_ansi( lines.map( ( line, index ) => {
        let past_cursor = index > start
        return line.split( /(\x1b\[[0-9:;]*m)/ ).map( part => {
            if( /^\x1b\[/.test( part ) && part.endsWith( `m` ) ) {
                const parameters = part.slice( 2, -1 ).split( `;` )
                for( let offset = 0; offset < parameters.length; offset++ ) {
                    const parameter = parameters[ offset ]
                    // RGB/indexed colour payloads can contain 0, 2 or 22. They
                    // are colours, not intensity changes (colon forms too).
                    if( parameter.includes( `:` ) ) continue
                    const code = Number( parameter )
                    if( [ 38, 48, 58 ].includes( code ) ) {
                        offset += parameters[ offset + 1 ] === `2` ? 4 : parameters[ offset + 1 ] === `5` ? 2 : 0
                    } else if( code === 2 ) dim = true
                    else if( code === 0 || code === 22 ) dim = false
                }
                return ``
            }
            if( index < start || index >= end ) return part
            if( !past_cursor ) {
                const cursor = part.indexOf( `❯` )
                if( cursor < 0 ) return part
                past_cursor = true
                return dim ? part.slice( 0, cursor + 1 ) : part
            }
            return dim ? `` : part
        } ).join( `` )
    } ).join( `\n` ) )
}

// An existing panel or a person's draft belongs to them. Never close it or
// type into it. The host retries CONTROL_PENDING after the screen is clear.
const ensure_safe = ( agent, rules, screen, busy ) => {
    if( busy && !rules.control_while_busy ) throw pending( `Wait for ${ agent } to finish the active turn.` )
    const dialog = /(?:^|\n)\s*(?:Do you trust[^\n]*\?|Select login method|Set Effort|Switch Model|Select model(?:\s+esc)?|Select variant(?:\s+esc)?|Search:|Change effort level\?|Switch model\?)\s*(?:\n|$)/im.test( screen )
    if( dialog ) {
        throw pending( `An agent dialog is already open.` )
    }

    const draft = rules.composer_draft?.( screen )
    if( draft ) throw pending( draft )
}

/**
 * Drive one Babysit-owned native TUI control through its exact tmux pane.
 * The host serializes calls and retries CONTROL_PENDING until a safe screen.
 * A failed control never presses Escape on an unowned dialog.
 */
export const terminal_control = async ( {
    agent, operation, value, target, capture, capture_styled, send_text, send_keys,
    dismiss, busy = false, timeout_ms = DEFAULT_TIMEOUT_MS,
} ) => {
    if( ![ `model`, `effort` ].includes( operation ) ) throw new Error( `Unknown terminal control '${ operation }'.` )
    if( value !== undefined && !/^[\x20-\x7E]{1,160}$/.test( value ) ) throw new Error( `Control value contains unsupported characters.` )
    if( typeof capture !== `function` || typeof send_text !== `function` || typeof send_keys !== `function` ) throw new Error( `Terminal control needs capture, send_text and send_keys callbacks.` )
    // Each adapter's `screen` owns its dialogs, composer and native controller
    const rules = get_agent( agent )?.screen || {}
    const owned_dialog = current => Boolean( rules.owned_dialog?.( current ) )
    const screen = await capture()
    ensure_safe( agent, rules, capture_styled ? without_ghost_text( await capture_styled() ) : screen, busy )
    let opened = false
    let escaped = false
    const tracked_send_text = async text => {
        await send_text( text )
        opened = true
        escaped = false
    }
    const tracked_send_keys = async ( ...keys ) => {
        await send_keys( ...keys )
        if( keys.includes( `Escape` ) ) escaped = true
    }
    // A controller that leaves and reopens a picker reacquires the composer first
    const reacquire = async () => ensure_safe( agent, rules, capture_styled ? without_ghost_text( await capture_styled() ) : await capture(), false )
    const context = { operation, value, target, capture, send_text: tracked_send_text, send_keys: tracked_send_keys, timeout_ms, screen_before: screen, reacquire }
    try {
        if( !rules.control ) throw unsupported( `${ agent } does not have a native terminal controller.` )
        return await rules.control( context )
    } catch ( error ) {
        // CONTROL_PENDING means the composer/dialog now belongs to someone
        // else. Do not dismiss it while cleaning up our earlier operation.
        if( opened && !escaped && error.code !== `CONTROL_PENDING` ) {
            try {
                if( dismiss ) await dismiss( owned_dialog )
                else if( owned_dialog( await capture() ) ) await send_keys( `Escape` )
            } catch { /* Preserve the control error if the pane has closed. */ }
        }
        throw error
    }
}
