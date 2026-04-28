import { writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
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

/**
 * Build a Claude settings.json that includes the babysit statusline override.
 * Reads the host's settings.json (if any), merges in the statusline command,
 * and writes the result to a tmpfile that callers bind-mount into the container.
 * Never modifies the host file directly.
 * @param {string} host_settings_path - Path to the host's settings.json (may not exist)
 * @returns {string|null} Tmpfile path that should be bind-mounted, or null on error
 */
export const build_claude_settings_tmpfile = ( host_settings_path ) => {

    try {

        let settings = {}
        if( existsSync( host_settings_path ) ) {
            settings = JSON.parse( readFileSync( host_settings_path, `utf-8` ) )
        }

        settings.statusLine = {
            type: `command`,
            command: `bash /usr/local/bin/statusline.sh`,
        }

        const tmpfile = join( tmpdir(), `babysit-claude-settings-${ Date.now() }.json` )
        writeFileSync( tmpfile, JSON.stringify( settings, null, 2 ) )
        log.debug( `Built Claude settings tmpfile: ${ tmpfile }` )

        return tmpfile

    } catch ( e ) {
        log.debug( `Failed to build settings tmpfile: ${ e.message }` )
        return null
    }

}
