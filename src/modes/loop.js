import { existsSync } from 'fs'
import { resolve, join } from 'path'
import { log } from '../utils/log.js'
import { AGENTS_DIR } from '../utils/paths.js'

// Default loop text when no LOOP.md is found
const DEFAULT_LOOP_TEXT = `Keep going`

/**
 * Apply loop mode — overrides the `on: idle` rule in babysit.yaml
 * Priority: ./LOOP.md > ~/.agents/LOOP.md > "Keep going"
 * @param {Array} rules - The parsed babysit rules array (mutated in place)
 * @param {string} [workspace=process.cwd()] - Current working directory
 */
export const apply_loop = ( rules, workspace = process.cwd() ) => {

    // Find the loop source
    const local_loop = resolve( workspace, `LOOP.md` )
    const global_loop = join( AGENTS_DIR, `LOOP.md` )

    let loop_action

    if( existsSync( local_loop ) ) {
        loop_action = local_loop
        log.info( `Loop mode: using ${ local_loop }` )
    } else if( existsSync( global_loop ) ) {
        loop_action = global_loop
        log.info( `Loop mode: using ${ global_loop }` )
    } else {
        loop_action = DEFAULT_LOOP_TEXT
        log.info( `Loop mode: no LOOP.md found, using "${ DEFAULT_LOOP_TEXT }"` )
    }

    // Find and override the idle rule, or insert one at position 0
    const idle_index = rules.findIndex( r => r.on.type === `idle` )

    const loop_rule = {
        on: { type: `idle` },
        do: loop_action,
        timeout_s: null,
        last_fired_at: 0,
    }

    if( idle_index >= 0 ) {
        rules[ idle_index ] = loop_rule
    } else {
        rules.unshift( loop_rule )
    }

}
