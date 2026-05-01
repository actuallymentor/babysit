import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

import { log } from '../utils/log.js'
import { BABYSIT_DIR } from '../utils/paths.js'

// Host-side state file written by the monitor. It is bind-mounted into the
// container at LOOP_DEADLINE_CONTAINER_PATH, which statusline.sh reads.
export const LOOP_DEADLINE_PATH = join( BABYSIT_DIR, `loop-deadline` )
export const LOOP_DEADLINE_CONTAINER_PATH = `/tmp/babysit-loop-deadline`

/**
 * Write the loop deadline file so the statusline can show a countdown.
 * Pass a unix epoch (seconds), or the literal `"idle"` to clear the countdown.
 * @param {number|string} deadline - Unix epoch seconds or "idle"
 */
export const write_loop_deadline = ( deadline ) => {

    try {
        mkdirSync( dirname( LOOP_DEADLINE_PATH ), { recursive: true } )
        writeFileSync( LOOP_DEADLINE_PATH, String( deadline ) )
        return true
    } catch ( e ) {
        log.debug( `Failed to write loop deadline: ${ e.message }` )
        return false
    }

}
