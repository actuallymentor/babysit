import { register_live_log_line } from '../utils/log.js'

const SPINNER_FRAMES = [ `⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`, `⠦`, `⠧`, `⠇`, `⠏` ]

/**
 * Render the current startup phase as one live terminal line.
 * @param {string} label - Launch label, for example "Starting claude"
 * @param {string} phase - Current phase description
 * @param {Object} options - Timing and style
 * @returns {string} Single terminal line
 */
export const format_startup_status_line = ( label, phase, {
    started_at,
    now,
    frame = SPINNER_FRAMES[0],
    unicode = true,
} ) => `${ unicode ? frame : `...` } ${ label }: ${ phase } ${ ( ( now - started_at ) / 1_000 ).toFixed( 1 ) }s`

/**
 * Show which startup step is running before any blocking work begins.
 * Silent off a TTY; other diagnostics clear and restore the line through
 * register_live_log_line, exactly like the authentication spinner.
 *
 * @param {string} label - Launch label shown on every phase
 * @param {Object} [options] - Terminal and timer seams
 * @returns {{ set: Function, pause: Function, stop: Function }} Status controls
 */
export const start_startup_status = ( label, {
    output = process.stdout,
    env = process.env,
    now = Date.now,
    set_interval = setInterval,
    clear_interval = clearInterval,
} = {} ) => {

    const animated = Boolean( output.isTTY && env.TERM !== `dumb` )
    let phase = null
    let started_at = now()
    let frame_index = 0
    let interval = null
    let unregister = null

    const clear = () => output.write( `\r\x1b[2K` )
    const render = () => {
        if( !phase ) return
        const frame = SPINNER_FRAMES[ frame_index % SPINNER_FRAMES.length ]
        frame_index += 1
        // Clip to one physical row: a wrapped line would leave a stale row
        // behind every redraw in a narrow pane.
        const width = Math.max( 1, ( output.columns || 80 ) - 1 )
        const line = Array.from( format_startup_status_line( label, phase, { started_at, now: now(), frame } ) ).slice( 0, width ).join( `` )
        output.write( `\r\x1b[2K${ line }` )
    }

    // Remove the live line so prompts and other spinners own the terminal.
    const pause = () => {
        if( interval ) clear_interval( interval )
        interval = null
        unregister?.()
        unregister = null
        if( animated && phase ) clear()
        phase = null
    }

    const set = next_phase => {
        phase = next_phase
        started_at = now()
        if( !animated ) return
        if( !interval ) {
            unregister = register_live_log_line( { clear, render } )
            interval = set_interval( render, 100 )
            interval.unref?.()
        }
        render()
    }

    return { set, pause, stop: pause }

}
