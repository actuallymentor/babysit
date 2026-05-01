import { writeFileSync } from 'fs'

import { log } from '../utils/log.js'

// Shared host path the statusline reads — also bind-mounted into the container.
// One file per babysit cli process is sufficient because each cli supervises one container.
export const LOOP_DEADLINE_PATH = `/tmp/babysit-loop-deadline`

/**
 * Write the loop deadline file so the statusline can show a countdown.
 * Pass a unix epoch (seconds), or the literal `"idle"` to clear the countdown.
 * @param {number|string} deadline - Unix epoch seconds or "idle"
 */
export const write_loop_deadline = ( deadline ) => {

    try {
        writeFileSync( LOOP_DEADLINE_PATH, String( deadline ) )
    } catch ( e ) {
        log.debug( `Failed to write loop deadline: ${ e.message }` )
    }

}
