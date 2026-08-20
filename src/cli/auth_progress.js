const SPINNER_FRAMES = [ `⠋`, `⠙`, `⠹`, `⠸`, `⠼`, `⠴`, `⠦`, `⠧`, `⠇`, `⠏` ]
const ACTIVE_STATES = new Set( [ `preparing`, `checking`, `recovering credentials` ] )

const elapsed_seconds = ( started_at, now ) => ( ( now - started_at ) / 1_000 ).toFixed( 1 )

const state_marker = ( state, frame, unicode ) => {

    if( ACTIVE_STATES.has( state ) ) return unicode ? frame : `...`
    if( [ `authenticated`, `cached` ].includes( state ) ) return unicode ? `✓` : `ok`
    if( state === `skipped` ) return unicode ? `↷` : `skip`
    return unicode ? `✗` : `fail`

}

/**
 * Render one compact authentication progress line without secrets or model
 * output.
 *
 * @param {Map<string,string>} states - Per-agent progress states
 * @param {Object} options - Render settings
 * @returns {string} Single terminal line
 */
export const format_auth_progress_line = ( states, {
    started_at,
    now,
    frame = SPINNER_FRAMES[0],
    unicode = true,
    allow_skip = true,
} ) => {

    const agents = [ ...states ].map( ( [ name, state ] ) =>
        `${ name } ${ state_marker( state, frame, unicode ) }${ ACTIVE_STATES.has( state ) ? ` ${ state }` : `` }`
    )
    const hint = allow_skip ? ` — press Enter to skip` : ``

    return `Checking authentication ${ elapsed_seconds( started_at, now ) }s${ hint } — ${ agents.join( `, ` ) }`
}

const final_state_for = result => {
    if( result.status ) return result.status
    return result.authenticated ? `authenticated` : `failed`
}

/**
 * Run authentication work with a TTY-only Enter guard and compact progress.
 * Cancellation remains cooperative: this function does not resolve until all
 * probe finalizers have recovered credentials and cleaned their containers.
 *
 * @param {Object[]} agents - Agents being checked
 * @param {Function} run_checks - Async ({ signal, on_state }) auth runner
 * @param {Object} [options]
 * @returns {Promise<Array>} Authentication results
 */
export const run_auth_checks_with_progress = async ( agents, run_checks, {
    input = process.stdin,
    output = process.stdout,
    allow_skip = true,
    env = process.env,
    now = Date.now,
    set_interval = setInterval,
    clear_interval = clearInterval,
    kill_process = process.kill.bind( process ),
} = {} ) => {

    const controller = new AbortController()
    const states = new Map( agents.map( agent => [ agent.name, `preparing` ] ) )
    const started_at = now()
    const unicode = env.TERM !== `dumb`
    const animated = Boolean( output.isTTY && env.TERM !== `dumb` )
    const can_read_keys = Boolean( allow_skip && input.isTTY && typeof input.on === `function` )
    const was_raw = Boolean( input.isRaw )
    const was_paused = input.isPaused?.() ?? false
    let frame_index = 0
    let interrupted = false
    let skipped = false
    let interval = null
    let run_error = null

    const render = () => {
        const line = format_auth_progress_line( states, {
            started_at,
            now: now(),
            frame: SPINNER_FRAMES[ frame_index % SPINNER_FRAMES.length ],
            unicode,
            allow_skip: can_read_keys,
        } )
        frame_index += 1
        output.write( animated ? `\r\x1b[2K${ line }` : `${ line }\n` )
    }

    const on_state = ( name, state ) => {
        states.set( name, state )
        if( animated ) render()
    }

    const on_data = chunk => {
        const text = chunk.toString()

        if( text.includes( `\x03` ) ) {
            interrupted = true
            controller.abort( { code: `interrupt` } )
            return
        }

        if( /[\r\n]/.test( text ) && !controller.signal.aborted ) {
            skipped = true
            output.write( animated
                ? `\r\x1b[2KSkipping authentication checks; cleaning up...\n`
                : `Skipping authentication checks; cleaning up...\n`
            )
            controller.abort( { code: `skip` } )
        }
    }

    if( can_read_keys ) {
        input.setRawMode?.( true )
        input.resume?.()
        input.on( `data`, on_data )
    }

    render()
    if( animated ) {
        interval = set_interval( render, 100 )
        interval.unref?.()
    }

    let results
    try {
        results = await run_checks( { signal: controller.signal, on_state } )
        results.forEach( result => states.set( result.name, final_state_for( result ) ) )
    } catch ( error ) {
        run_error = error
    } finally {
        if( interval ) clear_interval( interval )
        if( can_read_keys ) {
            input.removeListener( `data`, on_data )
            input.setRawMode?.( was_raw )
            if( was_paused ) input.pause?.()
        }
        if( animated ) output.write( `\r\x1b[2K` )
    }

    if( interrupted ) kill_process( process.pid, `SIGINT` )
    if( run_error ) throw run_error

    output.write( `${ skipped ? `Authentication checks skipped` : `Authentication checks complete` }: ${
        [ ...states ].map( ( [ name, state ] ) => `${ name } ${ state }` ).join( `, ` )
    }\n` )

    return results
}
